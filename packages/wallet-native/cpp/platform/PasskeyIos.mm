// iOS passkey authenticator (W6c): ASAuthorization platform passkeys with the
// PRF extension (iOS 18+). The kernel builds the WebAuthn request JSON and
// parses the response JSON itself; this file only reads the fields the system
// ceremony needs, runs one ASAuthorizationController at a time and repacks the
// credential into the browser `toJSON()` shape the kernel parses. PRF outputs
// are encoded straight into the response JSON — no copies are kept and they
// are never logged.
#include "../host/Passkey.hpp"

#import <AuthenticationServices/AuthenticationServices.h>
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <os/log.h>

#include <mutex>
#include <string>
#include <utility>

@class QntxPasskeySession;

namespace {

os_log_t passkeyLog() {
  static os_log_t log = os_log_create("org.qntx.wallet", "passkey");
  return log;
}

// The controller and its delegate stay alive only while a ceremony is in
// flight (controller.delegate is weak). Both are touched on the main thread
// only; the mutex pairs the one-in-flight check with the clear on completion.
std::mutex g_mutex;
ASAuthorizationController* g_controller = nil;
QntxPasskeySession* g_session = nil;

// Strict base64url decode (padding restored); nil on any invalid character.
NSData* _Nullable base64urlDecode(NSString* _Nullable value) {
  if (value == nil) {
    return nil;
  }
  NSMutableString* standard = [NSMutableString stringWithCapacity:value.length + 3];
  for (NSUInteger i = 0; i < value.length; i += 1) {
    const unichar c = [value characterAtIndex:i];
    if (c == '-') {
      [standard appendString:@"+"];
    } else if (c == '_') {
      [standard appendString:@"/"];
    } else if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      [standard appendFormat:@"%C", c];
    } else {
      return nil;
    }
  }
  if (standard.length % 4 == 1) {
    return nil;
  }
  while (standard.length % 4 != 0) {
    [standard appendString:@"="];
  }
  return [[NSData alloc] initWithBase64EncodedString:standard options:0];
}

NSString* base64urlEncode(NSData* data) {
  NSString* standard = [data base64EncodedStringWithOptions:0];
  standard = [standard stringByReplacingOccurrencesOfString:@"+" withString:@"-"];
  standard = [standard stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
  while ([standard hasSuffix:@"="]) {
    standard = [standard substringToIndex:standard.length - 1];
  }
  return standard;
}

NSDictionary<NSString*, id>* _Nullable dictOf(_Nullable id value) {
  return [value isKindOfClass:NSDictionary.class] ? (NSDictionary<NSString*, id>*)value : nil;
}

NSString* _Nullable stringOf(_Nullable id value) {
  return [value isKindOfClass:NSString.class] ? (NSString*)value : nil;
}

NSArray* _Nullable arrayOf(_Nullable id value) {
  return [value isKindOfClass:NSArray.class] ? (NSArray*)value : nil;
}

NSDictionary<NSString*, id>* _Nullable jsonOf(const std::string& json) {
  NSData* data = [NSData dataWithBytes:json.data() length:json.size()];
  return dictOf([NSJSONSerialization JSONObjectWithData:data options:0 error:nil]);
}

// The extensions.prf.eval block the kernel always sends; nil when missing or
// malformed (eval.second is optional).
ASAuthorizationPublicKeyCredentialPRFAssertionInputValues* _Nullable prfEval(
    NSDictionary<NSString*, id>* request) API_AVAILABLE(ios(18.0)) {
  NSDictionary* eval = dictOf(dictOf(dictOf(request[@"extensions"])[@"prf"])[@"eval"]);
  NSData* first = base64urlDecode(stringOf(eval[@"first"]));
  if (first == nil) {
    return nil;
  }
  NSData* second = nil;
  if (eval[@"second"] != nil) {
    second = base64urlDecode(stringOf(eval[@"second"]));
    if (second == nil) {
      return nil;
    }
  }
  return [[ASAuthorizationPublicKeyCredentialPRFAssertionInputValues alloc]
      initWithSaltInput1:first
              saltInput2:second];
}

ASPresentationAnchor _Nullable keyWindow() {
  for (UIScene* scene in UIApplication.sharedApplication.connectedScenes) {
    if ([scene isKindOfClass:UIWindowScene.class] &&
        scene.activationState == UISceneActivationStateForegroundActive) {
      UIWindow* window = ((UIWindowScene*)scene).keyWindow;
      if (window != nil) {
        return window;
      }
    }
  }
  return nil;
}

std::string jsonString(NSDictionary<NSString*, id>* json) {
  NSData* data = [NSJSONSerialization dataWithJSONObject:json options:0 error:nil];
  if (data == nil) {
    return {};
  }
  return std::string(static_cast<const char*>(data.bytes), data.length);
}

} // namespace

API_AVAILABLE(ios(18.0))
@interface QntxPasskeySession : NSObject <ASAuthorizationControllerDelegate,
                                          ASAuthorizationControllerPresentationContextProviding>
- (instancetype)initWithDone:(qntx::PasskeyDone)done anchor:(ASPresentationAnchor)anchor;
- (void)finish:(qntx::PasskeyResult)result;
@end

@implementation QntxPasskeySession {
  qntx::PasskeyDone _done;
  ASPresentationAnchor _anchor;
}

- (instancetype)initWithDone:(qntx::PasskeyDone)done anchor:(ASPresentationAnchor)anchor {
  self = [super init];
  if (self != nil) {
    _done = std::move(done);
    _anchor = anchor;
  }
  return self;
}

// Runs exactly once per session; clears the in-flight pair before invoking
// the kernel completion.
- (void)finish:(qntx::PasskeyResult)result {
  qntx::PasskeyDone done;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (g_session != self) {
      return;
    }
    g_controller = nil;
    g_session = nil;
    done = std::move(_done);
    _done = nullptr;
  }
  done(std::move(result));
}

- (ASPresentationAnchor)presentationAnchorForAuthorizationController:
    (ASAuthorizationController*)controller {
  return _anchor;
}

- (void)authorizationController:(ASAuthorizationController*)controller
    didCompleteWithAuthorization:(ASAuthorization*)authorization {
  NSMutableDictionary<NSString*, id>* extensions = [NSMutableDictionary new];
  NSMutableDictionary<NSString*, id>* response = [NSMutableDictionary new];
  std::string credentialId;
  if ([authorization.credential
          isKindOfClass:ASAuthorizationPlatformPublicKeyCredentialRegistration.class]) {
    auto* credential = (ASAuthorizationPlatformPublicKeyCredentialRegistration*)
        authorization.credential;
    NSString* id64 = base64urlEncode(credential.credentialID);
    credentialId = std::string(id64.UTF8String);
    response[@"clientDataJSON"] = base64urlEncode(credential.rawClientDataJSON);
    if (credential.rawAttestationObject != nil) {
      response[@"attestationObject"] = base64urlEncode(credential.rawAttestationObject);
    }
    if (credential.prf != nil) {
      NSMutableDictionary<NSString*, id>* prf =
          [@{ @"enabled" : @(credential.prf.isSupported) } mutableCopy];
      if (credential.prf.first != nil) {
        NSMutableDictionary<NSString*, id>* results =
            [@{ @"first" : base64urlEncode(credential.prf.first) } mutableCopy];
        if (credential.prf.second != nil) {
          results[@"second"] = base64urlEncode(credential.prf.second);
        }
        prf[@"results"] = results;
      }
      extensions[@"prf"] = prf;
    }
  } else if ([authorization.credential
                 isKindOfClass:ASAuthorizationPlatformPublicKeyCredentialAssertion.class]) {
    auto* credential = (ASAuthorizationPlatformPublicKeyCredentialAssertion*)
        authorization.credential;
    NSString* id64 = base64urlEncode(credential.credentialID);
    credentialId = std::string(id64.UTF8String);
    response[@"clientDataJSON"] = base64urlEncode(credential.rawClientDataJSON);
    response[@"authenticatorData"] = base64urlEncode(credential.rawAuthenticatorData);
    response[@"signature"] = base64urlEncode(credential.signature);
    response[@"userHandle"] = base64urlEncode(credential.userID);
    if (credential.prf != nil) {
      NSMutableDictionary<NSString*, id>* results =
          [@{ @"first" : base64urlEncode(credential.prf.first) } mutableCopy];
      if (credential.prf.second != nil) {
        results[@"second"] = base64urlEncode(credential.prf.second);
      }
      extensions[@"prf"] = @{ @"results" : results };
    }
  } else {
    [self finish:qntx::PasskeyResult{qntx::PasskeyStatus::failed, {}}];
    return;
  }
  std::string json = jsonString(@{
    @"id" : @(credentialId.c_str()),
    @"rawId" : @(credentialId.c_str()),
    @"type" : @"public-key",
    @"authenticatorAttachment" : @"platform",
    @"response" : response,
    @"clientExtensionResults" : extensions,
  });
  if (json.empty()) {
    [self finish:qntx::PasskeyResult{qntx::PasskeyStatus::failed, {}}];
    return;
  }
  [self finish:qntx::PasskeyResult{qntx::PasskeyStatus::ok, std::move(json)}];
}

- (void)authorizationController:(ASAuthorizationController*)controller
           didCompleteWithError:(NSError*)error {
  qntx::PasskeyStatus status = qntx::PasskeyStatus::failed;
  if ([error.domain isEqualToString:ASAuthorizationErrorDomain]) {
    switch (error.code) {
      case ASAuthorizationErrorCanceled:
        status = qntx::PasskeyStatus::cancelled;
        break;
      case ASAuthorizationErrorNotHandled:
      case ASAuthorizationErrorFailed:
      case ASAuthorizationErrorNotInteractive:
        status = qntx::PasskeyStatus::unavailable;
        break;
      default:
        // 1010 = ASAuthorizationErrorDeviceNotConfiguredForPasskeyCreation,
        // compared raw so the iOS 19 symbol needs no availability guard.
        status = error.code == 1010 ? qntx::PasskeyStatus::unavailable
                                    : qntx::PasskeyStatus::failed;
    }
  }
  // Domain and code only — userInfo/localizedDescription can name the account.
  os_log_error(
      passkeyLog(),
      "passkey ceremony failed: %{public}@/%ld",
      error.domain,
      static_cast<long>(error.code));
  [self finish:qntx::PasskeyResult{status, {}}];
}

@end

namespace {

ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest* _Nullable registrationRequest(
    NSDictionary<NSString*, id>* request) API_AVAILABLE(ios(18.0)) {
  NSDictionary* rp = dictOf(request[@"rp"]);
  NSDictionary* user = dictOf(request[@"user"]);
  NSString* rpId = stringOf(rp[@"id"]);
  NSString* name = stringOf(user[@"name"]);
  NSData* challenge = base64urlDecode(stringOf(request[@"challenge"]));
  NSData* userId = base64urlDecode(stringOf(user[@"id"]));
  ASAuthorizationPublicKeyCredentialPRFAssertionInputValues* eval = prfEval(request);
  if (rpId == nil || name == nil || challenge == nil || userId == nil || eval == nil) {
    return nil;
  }
  auto* provider = [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc]
      initWithRelyingPartyIdentifier:rpId];
  auto* platform = [provider createCredentialRegistrationRequestWithChallenge:challenge
                                                                       name:name
                                                                     userID:userId];
  platform.userVerificationPreference =
      ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired;
  platform.attestationPreference = ASAuthorizationPublicKeyCredentialAttestationKindNone;
  platform.prf = [[ASAuthorizationPublicKeyCredentialPRFRegistrationInput alloc]
      initWithInputValues:eval];
  return platform;
}

ASAuthorizationPlatformPublicKeyCredentialAssertionRequest* _Nullable assertionRequest(
    NSDictionary<NSString*, id>* request) API_AVAILABLE(ios(18.0)) {
  NSString* rpId = stringOf(request[@"rpId"]);
  NSData* challenge = base64urlDecode(stringOf(request[@"challenge"]));
  ASAuthorizationPublicKeyCredentialPRFAssertionInputValues* eval = prfEval(request);
  if (rpId == nil || challenge == nil || eval == nil) {
    return nil;
  }
  auto* provider = [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc]
      initWithRelyingPartyIdentifier:rpId];
  auto* platform = [provider createCredentialAssertionRequestWithChallenge:challenge];
  if (request[@"allowCredentials"] != nil) {
    NSArray* allow = arrayOf(request[@"allowCredentials"]);
    if (allow == nil) {
      return nil;
    }
    NSMutableArray<ASAuthorizationPlatformPublicKeyCredentialDescriptor*>* descriptors =
        [NSMutableArray arrayWithCapacity:allow.count];
    for (id item in allow) {
      NSData* credentialId = base64urlDecode(stringOf(dictOf(item)[@"id"]));
      if (credentialId == nil) {
        return nil;
      }
      [descriptors addObject:[[ASAuthorizationPlatformPublicKeyCredentialDescriptor alloc]
                                 initWithCredentialID:credentialId]];
    }
    platform.allowedCredentials = descriptors;
  }
  platform.userVerificationPreference =
      ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired;
  platform.prf = [[ASAuthorizationPublicKeyCredentialPRFAssertionInput alloc]
      initWithInputValues:eval
      perCredentialInputValues:nil];
  return platform;
}

// Claims the single in-flight slot and runs the ceremony (main thread). A nil
// request means the JSON was malformed, a busy slot a second concurrent call.
void run(ASAuthorizationRequest* _Nullable request, qntx::PasskeyDone done)
    API_AVAILABLE(ios(18.0)) {
  if (request == nil) {
    done(qntx::PasskeyResult{qntx::PasskeyStatus::failed, {}});
    return;
  }
  ASPresentationAnchor anchor = keyWindow();
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_controller != nil) {
    done(qntx::PasskeyResult{qntx::PasskeyStatus::failed, {}});
    return;
  }
  if (anchor == nil) {
    done(qntx::PasskeyResult{qntx::PasskeyStatus::unavailable, {}});
    return;
  }
  QntxPasskeySession* session = [[QntxPasskeySession alloc] initWithDone:std::move(done)
                                                                anchor:anchor];
  ASAuthorizationController* controller = [[ASAuthorizationController alloc]
      initWithAuthorizationRequests:@[ request ]];
  controller.delegate = session;
  controller.presentationContextProvider = session;
  g_session = session;
  g_controller = controller;
  [controller performRequests];
}

} // namespace

namespace qntx {

void passkeyCreate(std::string requestJson, PasskeyDone done) {
  auto json = std::make_shared<std::string>(std::move(requestJson));
  auto finish = std::make_shared<PasskeyDone>(std::move(done));
  dispatch_async(dispatch_get_main_queue(), ^{
    if (@available(iOS 18.0, *)) {
      run(registrationRequest(jsonOf(*json)), std::move(*finish));
    } else {
      (*finish)(PasskeyResult{PasskeyStatus::unavailable, {}});
    }
  });
}

void passkeyGet(std::string requestJson, PasskeyDone done) {
  auto json = std::make_shared<std::string>(std::move(requestJson));
  auto finish = std::make_shared<PasskeyDone>(std::move(done));
  dispatch_async(dispatch_get_main_queue(), ^{
    if (@available(iOS 18.0, *)) {
      run(assertionRequest(jsonOf(*json)), std::move(*finish));
    } else {
      (*finish)(PasskeyResult{PasskeyStatus::unavailable, {}});
    }
  });
}

void passkeyCancel() {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (@available(iOS 16.0, *)) {
      std::lock_guard<std::mutex> lock(g_mutex);
      [g_controller cancel];
    }
  });
}

} // namespace qntx
