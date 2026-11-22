#pragma once

#import <UIKit/UIKit.h>

// The only signal the mounted secure-input view reports to the main runtime.
// `submitted` is emitted on the clear that follows a confirmed entry, right
// before `idle`.
typedef NS_ENUM(NSInteger, QntxSecureInputState) {
  QntxSecureInputStateIdle = 0,
  QntxSecureInputStateEmpty,
  QntxSecureInputStateFilled,
  QntxSecureInputStateSubmitted,
};

// The trusted input surface: a label the kernel sets plus a text field the
// main runtime cannot reach. It takes no props — what to collect and which
// label to show arrive through SecureInputHub while the view is attached to
// a window.
@interface QntxSecureInputField : UIView

// Fired on the main queue on every state transition.
@property(nonatomic, copy, nullable) void (^onStateChange)(QntxSecureInputState state);

@end
