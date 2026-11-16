// iOS keystore (W5): one Secure Enclave P-256 key per vault factor, tagged
// org.qntx.wallet.vault.<factor id>. A presence key is readable only while a
// device passcode is set and usable only after a fresh user-presence check; a
// device key is accessible whenever the device is unlocked and never prompts.
// Sealing is ECIES with the public key (no prompt); opening decrypts with the
// private key — presence behind a new LAContext whose reason is the kernel's
// prompt text (every unlock, re-verification and per-operation verification is
// its own system prompt), device behind an interactionNotAllowed context.
// The simulator has no Secure Enclave: there the key lives in the software
// keychain with the same access control.
#include "../host/Keystore.hpp"

#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#include <TargetConditionals.h>

#include <cstring>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>

namespace qntx {
namespace {

NSString* const kTagPrefix = @"org.qntx.wallet.vault.";

SecKeyAlgorithm algorithm() {
  return kSecKeyAlgorithmECIESEncryptionCofactorVariableIVX963SHA256AESGCM;
}

dispatch_queue_t keystoreQueue() {
  static dispatch_queue_t queue =
      dispatch_queue_create("org.qntx.wallet.keystore", DISPATCH_QUEUE_SERIAL);
  return queue;
}

// The context of the prompt currently on screen, for keystoreCancel.
std::mutex g_contextMutex;
LAContext* g_context = nil;

void setCurrentContext(LAContext* context) {
  std::lock_guard<std::mutex> lock(g_contextMutex);
  g_context = context;
}

NSData* tagFor(const std::string& factorId) {
  NSString* suffix = [NSString stringWithUTF8String:factorId.c_str()];
  return [[kTagPrefix stringByAppendingString:suffix ?: @""]
      dataUsingEncoding:NSUTF8StringEncoding];
}

KeystoreStatus statusOf(NSError* error) {
  if (error == nil) {
    return KeystoreStatus::failed;
  }
  if ([error.domain isEqualToString:LAErrorDomain]) {
    switch (error.code) {
      case LAErrorUserCancel:
      case LAErrorAppCancel:
      case LAErrorSystemCancel:
      case LAErrorUserFallback:
        return KeystoreStatus::cancelled;
      case LAErrorPasscodeNotSet:
        return KeystoreStatus::noLockScreen;
      default:
        return KeystoreStatus::failed;
    }
  }
  if ([error.domain isEqualToString:NSOSStatusErrorDomain]) {
    switch (error.code) {
      case errSecUserCanceled:
        return KeystoreStatus::cancelled;
      case errSecItemNotFound:
        return KeystoreStatus::invalidated;
      default:
        return KeystoreStatus::failed;
    }
  }
  return KeystoreStatus::failed;
}

KeystoreStatus statusOf(CFErrorRef error) {
  return statusOf((__bridge NSError*)error);
}

// The "<domain>:<code>" diagnostic — never userInfo or localizedDescription,
// which can name the account.
std::string detailOf(NSError* error) {
  if (error == nil) {
    return {};
  }
  char buffer[96];
  std::snprintf(
      buffer,
      sizeof(buffer),
      "%s:%ld",
      error.domain.UTF8String,
      static_cast<long>(error.code));
  return buffer;
}

std::string detailOf(CFErrorRef error) {
  return detailOf((__bridge NSError*)error);
}

// A failed canEvaluatePolicy: LAErrorPasscodeNotSet is the one failure a user
// can act on (no device passcode → no hardware factor can exist), so it gets
// its own status; every other LAError is a plain platform failure.
KeystoreResult credentialProbeFailure(NSError* error) {
  return {
      error != nil && [error.domain isEqualToString:LAErrorDomain] &&
              error.code == LAErrorPasscodeNotSet
          ? KeystoreStatus::noLockScreen
          : KeystoreStatus::unavailable,
      {},
      detailOf(error)};
}

void deleteKey(NSData* tag) {
  SecItemDelete((__bridge CFDictionaryRef) @{
    (id)kSecClass : (id)kSecClassKey,
    (id)kSecAttrApplicationTag : tag,
  });
}

// The device-credential gate: seal cannot create a hardware key while the
// policy cannot be evaluated at all.
std::optional<KeystoreResult> deviceCredentialMissing() {
  LAContext* probe = [LAContext new];
  NSError* error = nil;
  if ([probe canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error]) {
    return std::nullopt;
  }
  return credentialProbeFailure(error);
}

KeystoreResult sealNow(
    const std::string& factorId, const SecretBytes& secret, bool presence) {
  // A presence key cannot exist while the policy cannot be evaluated at all;
  // a device key has no such gate.
  if (presence) {
    if (auto missing = deviceCredentialMissing()) {
      return std::move(*missing);
    }
  }
  NSData* tag = tagFor(factorId);
  deleteKey(tag);
  SecAccessControlCreateFlags flags = presence ? kSecAccessControlUserPresence : 0;
#if !TARGET_OS_SIMULATOR
  flags |= kSecAccessControlPrivateKeyUsage;
#endif
  CFErrorRef error = nullptr;
  SecAccessControlRef access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault,
      presence ? kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
               : kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      flags,
      &error);
  if (access == nullptr) {
    KeystoreResult out{KeystoreStatus::unavailable, {}, detailOf(error)};
    if (error != nullptr) {
      CFRelease(error);
    }
    return out;
  }
  NSMutableDictionary* attributes = [@{
    (id)kSecAttrKeyType : (id)kSecAttrKeyTypeECSECPrimeRandom,
    (id)kSecAttrKeySizeInBits : @256,
    (id)kSecPrivateKeyAttrs : @{
      (id)kSecAttrIsPermanent : @YES,
      (id)kSecAttrApplicationTag : tag,
      (id)kSecAttrAccessControl : (__bridge id)access,
    },
  } mutableCopy];
#if !TARGET_OS_SIMULATOR
  attributes[(id)kSecAttrTokenID] = (id)kSecAttrTokenIDSecureEnclave;
#endif
  SecKeyRef privateKey = SecKeyCreateRandomKey((__bridge CFDictionaryRef)attributes, &error);
  CFRelease(access);
  if (privateKey == nullptr) {
    KeystoreResult out{KeystoreStatus::unavailable, {}, detailOf(error)};
    if (error != nullptr) {
      CFRelease(error);
    }
    return out;
  }
  SecKeyRef publicKey = SecKeyCopyPublicKey(privateKey);
  CFRelease(privateKey);
  if (publicKey == nullptr) {
    deleteKey(tag);
    return {KeystoreStatus::failed, {}};
  }
  CFDataRef plain = CFDataCreateWithBytesNoCopy(
      kCFAllocatorDefault, secret.data(), static_cast<CFIndex>(secret.size()), kCFAllocatorNull);
  CFDataRef sealed = SecKeyCreateEncryptedData(publicKey, algorithm(), plain, &error);
  CFRelease(plain);
  CFRelease(publicKey);
  if (sealed == nullptr) {
    KeystoreResult out{KeystoreStatus::unavailable, {}, detailOf(error)};
    if (error != nullptr) {
      CFRelease(error);
    }
    deleteKey(tag);
    return out;
  }
  SecretBytes out(CFDataGetBytePtr(sealed), static_cast<size_t>(CFDataGetLength(sealed)));
  CFRelease(sealed);
  return {KeystoreStatus::ok, std::move(out)};
}

KeystoreResult openNow(
    const std::string& factorId,
    const std::vector<uint8_t>& sealed,
    LAContext* context) {
  CFTypeRef keyRef = nullptr;
  const OSStatus found = SecItemCopyMatching(
      (__bridge CFDictionaryRef) @{
        (id)kSecClass : (id)kSecClassKey,
        (id)kSecAttrKeyType : (id)kSecAttrKeyTypeECSECPrimeRandom,
        (id)kSecAttrApplicationTag : tagFor(factorId),
        (id)kSecReturnRef : @YES,
        (id)kSecUseAuthenticationContext : context,
      },
      &keyRef);
  auto privateKey = static_cast<SecKeyRef>(const_cast<void*>(keyRef));
  if (found == errSecItemNotFound) {
    return {KeystoreStatus::invalidated, {}};
  }
  if (found != errSecSuccess || privateKey == nullptr) {
    return {KeystoreStatus::failed, {}};
  }
  setCurrentContext(context);
  CFDataRef cipher = CFDataCreate(
      kCFAllocatorDefault, sealed.data(), static_cast<CFIndex>(sealed.size()));
  CFErrorRef error = nullptr;
  // Blocks this queue while the system verification is on screen.
  CFDataRef plain = SecKeyCreateDecryptedData(privateKey, algorithm(), cipher, &error);
  setCurrentContext(nil);
  CFRelease(cipher);
  CFRelease(privateKey);
  if (plain == nullptr) {
    const KeystoreStatus status = statusOf(error);
    if (error != nullptr) {
      CFRelease(error);
    }
    return {status, {}};
  }
  const auto length = static_cast<size_t>(CFDataGetLength(plain));
  SecretBytes out(CFDataGetBytePtr(plain), length);
  // The KEK must not outlive this copy: wipe the framework's buffer before
  // releasing it (it is our sole reference).
  std::memset(const_cast<UInt8*>(CFDataGetBytePtr(plain)), 0, length);
  CFRelease(plain);
  return {KeystoreStatus::ok, std::move(out)};
}

// Reads only keychain state: item attributes under an interactionNotAllowed
// context, and for a presence key the device-credential policy — a
// WhenPasscodeSet key cannot be valid while no passcode is set.
KeystoreResult probeNow(const std::string& factorId, KeyProtection protection) {
  LAContext* context = [LAContext new];
  context.interactionNotAllowed = YES;
  CFTypeRef found = nullptr;
  const OSStatus status = SecItemCopyMatching(
      (__bridge CFDictionaryRef) @{
        (id)kSecClass : (id)kSecClassKey,
        (id)kSecAttrKeyType : (id)kSecAttrKeyTypeECSECPrimeRandom,
        (id)kSecAttrApplicationTag : tagFor(factorId),
        (id)kSecReturnAttributes : @YES,
        (id)kSecUseAuthenticationContext : context,
      },
      &found);
  if (found != nullptr) {
    CFRelease(found);
  }
  if (status == errSecItemNotFound) {
    return {KeystoreStatus::invalidated, {}};
  }
  if (status != errSecSuccess && status != errSecInteractionNotAllowed) {
    return {KeystoreStatus::failed, {}};
  }
  if (protection == KeyProtection::presence) {
    NSError* error = nil;
    if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error] &&
        [error.domain isEqualToString:LAErrorDomain] && error.code == LAErrorPasscodeNotSet) {
      return {KeystoreStatus::invalidated, {}};
    }
  }
  return {KeystoreStatus::ok, {}};
}

} // namespace

void keystoreSeal(
    const std::string& factorId,
    SecretBytes secret,
    KeystorePrompt,
    KeystoreDone done) {
  // Blocks capture C++ references as references: copy everything the
  // asynchronous work needs into values first.
  const std::string alias = factorId;
  auto input = std::make_shared<SecretBytes>(std::move(secret));
  auto finish = std::make_shared<KeystoreDone>(std::move(done));
  dispatch_async(keystoreQueue(), ^{
    (*finish)(sealNow(alias, *input, true));
  });
}

void keystoreOpen(
    const std::string& factorId,
    std::vector<uint8_t> sealed,
    KeystorePrompt prompt,
    KeystoreDone done) {
  const std::string alias = factorId;
  const std::string reason = prompt.description;
  auto finish = std::make_shared<KeystoreDone>(std::move(done));
  dispatch_async(keystoreQueue(), ^{
    LAContext* context = [LAContext new];
    context.touchIDAuthenticationAllowableReuseDuration = 0;
    context.localizedReason = @(reason.c_str());
    (*finish)(openNow(alias, sealed, context));
  });
}

void keystoreSealDevice(const std::string& id, SecretBytes secret, KeystoreDone done) {
  const std::string alias = id;
  auto input = std::make_shared<SecretBytes>(std::move(secret));
  auto finish = std::make_shared<KeystoreDone>(std::move(done));
  dispatch_async(keystoreQueue(), ^{
    (*finish)(sealNow(alias, *input, false));
  });
}

void keystoreOpenDevice(
    const std::string& id,
    std::vector<uint8_t> sealed,
    KeystoreDone done) {
  const std::string alias = id;
  auto finish = std::make_shared<KeystoreDone>(std::move(done));
  dispatch_async(keystoreQueue(), ^{
    LAContext* context = [LAContext new];
    context.interactionNotAllowed = YES;
    (*finish)(openNow(alias, sealed, context));
  });
}

void keystoreProbe(const std::string& id, KeyProtection protection, KeystoreDone done) {
  const std::string alias = id;
  auto finish = std::make_shared<KeystoreDone>(std::move(done));
  dispatch_async(keystoreQueue(), ^{
    (*finish)(probeNow(alias, protection));
  });
}

void keystoreRemove(const std::string& id, KeystoreDone done) {
  const std::string alias = id;
  auto finish = std::make_shared<KeystoreDone>(std::move(done));
  dispatch_async(keystoreQueue(), ^{
    deleteKey(tagFor(alias));
    (*finish)(KeystoreResult{KeystoreStatus::ok, {}});
  });
}

void keystoreAuthenticate(KeystorePrompt prompt, KeystoreDone done) {
  auto finish = std::make_shared<KeystoreDone>(std::move(done));
  dispatch_async(keystoreQueue(), ^{
    LAContext* context = [LAContext new];
    context.touchIDAuthenticationAllowableReuseDuration = 0;
    NSError* error = nil;
    if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error]) {
      (*finish)(credentialProbeFailure(error));
      return;
    }
    setCurrentContext(context);
    // Keep the serial queue busy until the reply: one prompt at a time.
    dispatch_semaphore_t replied = dispatch_semaphore_create(0);
    __block KeystoreStatus status = KeystoreStatus::failed;
    [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
            localizedReason:@(prompt.description.c_str())
                      reply:^(BOOL success, NSError* error) {
                        status = success ? KeystoreStatus::ok : statusOf(error);
                        dispatch_semaphore_signal(replied);
                      }];
    dispatch_semaphore_wait(replied, DISPATCH_TIME_FOREVER);
    setCurrentContext(nil);
    (*finish)(KeystoreResult{status, {}});
  });
}

void keystoreClear(KeystoreDone done) {
  auto finish = std::make_shared<KeystoreDone>(std::move(done));
  dispatch_async(keystoreQueue(), ^{
    CFTypeRef found = nullptr;
    const OSStatus status = SecItemCopyMatching(
        (__bridge CFDictionaryRef) @{
          (id)kSecClass : (id)kSecClassKey,
          (id)kSecMatchLimit : (id)kSecMatchLimitAll,
          (id)kSecReturnAttributes : @YES,
        },
        &found);
    if (status == errSecSuccess && found != nullptr) {
      NSArray* items = (__bridge_transfer NSArray*)found;
      NSData* prefix = [kTagPrefix dataUsingEncoding:NSUTF8StringEncoding];
      for (NSDictionary* item in items) {
        NSData* tag = item[(id)kSecAttrApplicationTag];
        if ([tag isKindOfClass:[NSData class]] && tag.length > prefix.length &&
            [[tag subdataWithRange:NSMakeRange(0, prefix.length)] isEqualToData:prefix]) {
          deleteKey(tag);
        }
      }
    }
    const bool ok = status == errSecSuccess || status == errSecItemNotFound;
    (*finish)(KeystoreResult{ok ? KeystoreStatus::ok : KeystoreStatus::failed, {}});
  });
}

void keystoreCancel() {
  std::lock_guard<std::mutex> lock(g_contextMutex);
  [g_context invalidate];
}

std::string keystoreLocale() {
  NSString* language = NSLocale.preferredLanguages.firstObject;
  return language == nil ? "en" : std::string(language.UTF8String);
}

} // namespace qntx
