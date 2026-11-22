// The iOS half of the trusted input surface. The text field lives in
// Objective-C++ so the typed characters pass to SecureInputHub as bytes —
// they never become a Swift String and never cross the main runtime. The
// main runtime sees only QntxSecureInputState transitions.
#include "../host/SecureInput.hpp"
#include "QntxSecureInputField.h"

#import <Foundation/Foundation.h>

#include <optional>
#include <utility>
#include <vector>

// A text field that never offers the edit menu: the main runtime can read
// the clipboard, so paste/copy/cut are cut off in both directions.
@interface QntxSecureTextField : UITextField
@end

@implementation QntxSecureTextField

- (BOOL)canPerformAction:(SEL)action withSender:(id)sender {
  return NO;
}

@end

@interface QntxSecureInputField () <UITextFieldDelegate>
@end

@implementation QntxSecureInputField {
  UILabel* _label;
  QntxSecureTextField* _field;
  uint64_t _hubView;
  // The pending request's kind while the field is editable.
  BOOL _accessCode;
  // Set when this view's own submit() was accepted, so the hub's clear
  // reports `submitted` before `idle`.
  BOOL _justSubmitted;
  QntxSecureInputState _state;
}

- (instancetype)init {
  if (self = [super initWithFrame:CGRectZero]) {
    _state = QntxSecureInputStateIdle;
    _label = [[UILabel alloc] init];
    _label.numberOfLines = 0;
    _field = [[QntxSecureTextField alloc] init];
    _field.delegate = self;
    _field.enabled = NO;
    _field.returnKeyType = UIReturnKeyDone;
    [_field addTarget:self
                  action:@selector(textChanged)
        forControlEvents:UIControlEventEditingChanged];
    _label.translatesAutoresizingMaskIntoConstraints = NO;
    _field.translatesAutoresizingMaskIntoConstraints = NO;
    [self addSubview:_label];
    [self addSubview:_field];
    [NSLayoutConstraint activateConstraints:@[
      [_label.topAnchor constraintEqualToAnchor:self.topAnchor],
      [_label.leadingAnchor constraintEqualToAnchor:self.leadingAnchor],
      [_label.trailingAnchor constraintEqualToAnchor:self.trailingAnchor],
      [_field.topAnchor constraintEqualToAnchor:_label.bottomAnchor constant:8],
      [_field.leadingAnchor constraintEqualToAnchor:self.leadingAnchor],
      [_field.trailingAnchor constraintEqualToAnchor:self.trailingAnchor],
      [_field.bottomAnchor constraintEqualToAnchor:self.bottomAnchor],
    ]];
  }
  return self;
}

- (void)didMoveToWindow {
  [super didMoveToWindow];
  if (self.window != nil) {
    if (_hubView == 0) {
      __weak QntxSecureInputField* weakSelf = self;
      _hubView = qntx::SecureInputHub::shared().attach(
          [weakSelf](const std::optional<qntx::SecureInputPrompt>& prompt) {
            dispatch_async(dispatch_get_main_queue(), ^{
              [weakSelf applyPrompt:prompt];
            });
          });
    }
  } else {
    [self detachHub];
    [self disarm:NO];
  }
}

- (void)dealloc {
  [self detachHub];
}

- (void)detachHub {
  if (_hubView != 0) {
    qntx::SecureInputHub::shared().detach(_hubView);
    _hubView = 0;
  }
}

- (void)emit:(QntxSecureInputState)state {
  if (_state == state) {
    return;
  }
  _state = state;
  if (_onStateChange != nil) {
    _onStateChange(state);
  }
}

- (void)applyPrompt:(const std::optional<qntx::SecureInputPrompt>&)prompt {
  if (!prompt.has_value()) {
    const BOOL submitted = _justSubmitted;
    _justSubmitted = NO;
    [self disarm:submitted];
    return;
  }
  _justSubmitted = NO;
  _accessCode = prompt->kind == qntx::SecureInputKind::accessCode;
  _label.text = [[NSString alloc] initWithBytes:prompt->label.data()
                                       length:prompt->label.size()
                                     encoding:NSUTF8StringEncoding];
  [self arm];
}

- (void)arm {
  _field.enabled = YES;
  _field.secureTextEntry = _accessCode;
  _field.keyboardType = UIKeyboardTypeASCIICapable;
  _field.autocorrectionType = UITextAutocorrectionTypeNo;
  _field.spellCheckingType = UITextSpellCheckingTypeNo;
  _field.smartQuotesType = UITextSmartQuotesTypeNo;
  _field.smartDashesType = UITextSmartDashesTypeNo;
  _field.smartInsertDeleteType = UITextSmartInsertDeleteTypeNo;
  _field.autocapitalizationType =
      _accessCode ? UITextAutocapitalizationTypeNone : UITextAutocapitalizationTypeAllCharacters;
  if (_accessCode) {
    _field.font = nil;
  } else {
    _field.font = [UIFont monospacedDigitSystemFontOfSize:17 weight:UIFontWeightRegular];
  }
  [self emit:QntxSecureInputStateEmpty];
}

- (void)disarm:(BOOL)submitted {
  // The NSString inside UIKit cannot be erased; overwrite the field's copy
  // before clearing it — the best the platform can do.
  if (_field.text.length > 0) {
    _field.text =
        [@"" stringByPaddingToLength:_field.text.length
                          withString:@"0"
                     startingAtIndex:0];
  }
  _field.text = @"";
  _field.enabled = NO;
  [_field resignFirstResponder];
  _label.text = nil;
  if (submitted) {
    [self emit:QntxSecureInputStateSubmitted];
  }
  [self emit:QntxSecureInputStateIdle];
}

- (void)textChanged {
  [self emit:(_field.text.length > 0 ? QntxSecureInputStateFilled
                                    : QntxSecureInputStateEmpty)];
}

- (BOOL)textField:(UITextField*)field
    shouldChangeCharactersInRange:(NSRange)range
                replacementString:(NSString*)string {
  NSMutableString* next = [_field.text mutableCopy];
  [next replaceCharactersInRange:range withString:string];
  if (_accessCode) {
    if (next.length > 64) {
      return NO;
    }
    for (NSUInteger i = 0; i < next.length; i++) {
      const unichar c = [next characterAtIndex:i];
      if (c < 0x20 || c > 0x7E) {
        return NO;
      }
    }
    return YES;
  }
  // short-id: keep hex digits only, fold to upper-case, drop typed dashes.
  NSMutableString* filtered = [[NSMutableString alloc] init];
  for (NSUInteger i = 0; i < next.length; i++) {
    unichar c = [next characterAtIndex:i];
    if (c == (unichar)'-') {
      continue;
    }
    if (c >= 'a' && c <= 'f') {
      c -= 'a' - 'A';
    }
    const BOOL hex = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F');
    if (!hex || filtered.length >= 8) {
      return NO;
    }
    [filtered appendString:[NSString stringWithCharacters:&c length:1]];
  }
  // Returning NO suppresses UIControlEventEditingChanged, so the state
  // transition has to be reported from here.
  _field.text = filtered;
  [self textChanged];
  return NO;
}

- (BOOL)textFieldShouldReturn:(UITextField*)field {
  NSString* text = _field.text;
  const BOOL ready = _accessCode ? text.length >= 1 : text.length == 8;
  if (!ready) {
    return YES;
  }
  // Every accepted character is ASCII, so one UTF-16 unit is one byte.
  std::vector<uint8_t> bytes(text.length);
  for (NSUInteger i = 0; i < text.length; i++) {
    bytes[i] = static_cast<uint8_t>([text characterAtIndex:i]);
  }
  qntx::SecretBytes value(std::move(bytes));
  _justSubmitted =
      qntx::SecureInputHub::shared().submit(_hubView, std::move(value));
  if (!_justSubmitted) {
    // The hub's own clear follows on this queue; drop the text now too.
    _field.text = @"";
    [self emit:QntxSecureInputStateEmpty];
  }
  return YES;
}

@end
