import UIKit

/**
 * The SecureInputView HybridObject. The rendered view is the ObjC
 * `QntxSecureInputField` — the typed characters live in Objective-C++ and go
 * to the kernel's SecureInputHub as bytes; this class only forwards the
 * field's state transitions to the `onStateChange` prop.
 */
class HybridSecureInputView: HybridSecureInputViewSpec {
  let view = QntxSecureInputField()

  var onStateChange: (_ state: SecureInputState) -> Void = { _ in }

  override init() {
    super.init()
    view.onStateChange = { [weak self] state in
      self?.onStateChange(state.secureInputState)
    }
  }
}

private extension QntxSecureInputState {
  var secureInputState: SecureInputState {
    switch self {
    case .empty:
      return .empty
    case .filled:
      return .filled
    case .submitted:
      return .submitted
    default:
      return .idle
    }
  }
}
