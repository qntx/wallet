// iOS keystore (W5): one Secure Enclave P-256 key per vault factor, tagged
// org.qntx.wallet.vault.<factor id>, readable only while a device passcode is
// set and usable only after a fresh user-presence check. Sealing is ECIES with
// the public key (no prompt); opening decrypts with the private key behind a
// new LAContext whose reason is the kernel's prompt text, so every unlock,
// re-verification and per-operation verification is its own system prompt.
// The simulator has no Secure Enclave: there the key lives in the software
// keychain with the same user-presence access control.
#include "../host/Keystore.hpp"

#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#include <TargetConditionals.h>

#include <cstring>
#include <memory>
#include <mutex>
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

NSData* tagFor(const std::string& id) {
  NSString* tag = [kTagPrefix stringByAppendingString:@(id.c_str())];
  return [tag dataUsingEncoding:NSUTF8StringEncoding];
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
        return KeystoreStatus::unavailable;
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

void deleteKey(NSData* tag) {
  SecItemDelete((__bridge CFDictionaryRef) @{
    (id)kSecClass : (id)kSecClassKey,
    (id)kSecAttrApplicationTag : tag,
  });
}

bool deviceOwnerAuthenticationAvailable() {
  LAContext* probe = [LAContext new];
  return [probe canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:nil];
}

KeystoreResult sealNow(const std::string& id, const SecretBytes& secret) {
  if (!deviceOwnerAuthenticationAvailable()) {
    return {KeystoreStatus::unavailable, {}};
  }
  NSData* tag = tagFor(id);
  deleteKey(tag);
  SecAccessControlCreateFlags flags = kSecAccessControlUserPresence;
#if !TARGET_OS_SIMULATOR
  flags |= kSecAccessControlPrivateKeyUsage;
#endif
  CFErrorRef error = nullptr;
  SecAccessControlRef access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, flags, &error);
  if (access == nullptr) {
    if (error != nullptr) {
      CFRelease(error);
    }
    return {KeystoreStatus::unavailable, {}};
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
    if (error != nullptr) {
      CFRelease(error);
    }
    return {KeystoreStatus::unavailable, {}};
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
    if (error != nullptr) {
      CFRelease(error);
    }
    deleteKey(tag);
    return {KeystoreStatus::failed, {}};
  }
  SecretBytes out(CFDataGetBytePtr(sealed), static_cast<size_t>(CFDataGetLength(sealed)));
  CFRelease(sealed);
  return {KeystoreStatus::ok, std::move(out)};
}

KeystoreResult openNow(
    const std::string& id,
    const std::vector<uint8_t>& sealed,
    const KeystorePrompt& prompt) {
  LAContext* context = [LAContext new];
  context.touchIDAuthenticationAllowableReuseDuration = 0;
  context.localizedReason = @(prompt.description.c_str());
  SecKeyRef privateKey = nullptr;
  const OSStatus found = SecItemCopyMatching(
      (__bridge CFDictionaryRef) @{
        (id)kSecClass : (id)kSecClassKey,
        (id)kSecAttrKeyType : (id)kSecAttrKeyTypeECSECPrimeRandom,
        (id)kSecAttrApplicationTag : tagFor(id),
        (id)kSecReturnRef : @YES,
        (id)kSecUseAuthenticationContext : context,
      },
      reinterpret_cast<CFTypeRef*>(&privateKey));
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

} // namespace

void keystoreSeal(
    const std::string& id,
    SecretBytes secret,
    KeystorePrompt,
    KeystoreDone done) {
  auto input = std::make_shared<SecretBytes>(std::move(secret));
  auto finish = std::make_shared<KeystoreDone>(std::move(done));
  dispatch_async(keystoreQueue(), ^{
    (*finish)(sealNow(id, *input));
  });
}

void keystoreOpen(
    const std::string& id,
    std::vector<uint8_t> sealed,
    KeystorePrompt prompt,
    KeystoreDone done) {
  auto finish = std::make_shared<KeystoreDone>(std::move(done));
  dispatch_async(keystoreQueue(), ^{
    (*finish)(openNow(id, sealed, prompt));
  });
}

void keystoreAuthenticate(KeystorePrompt prompt, KeystoreDone done) {
  auto finish = std::make_shared<KeystoreDone>(std::move(done));
  dispatch_async(keystoreQueue(), ^{
    LAContext* context = [LAContext new];
    context.touchIDAuthenticationAllowableReuseDuration = 0;
    NSError* unavailable = nil;
    if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&unavailable]) {
      (*finish)(KeystoreResult{KeystoreStatus::unavailable, {}});
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
