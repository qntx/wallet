package com.margelo.nitro.qntxwallet

import android.view.View
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.uimanager.ThemedReactContext

/**
 * The Nitro view behind `SecureInput`: it owns a SecureInputField and forwards
 * its state transitions to the JS prop. Nothing else about the entry —
 * characters, length, kind or label — crosses to the main runtime.
 */
@DoNotStrip
@Keep
class HybridSecureInputView(context: ThemedReactContext) : HybridSecureInputViewSpec() {
  private val field = SecureInputField(context)

  override var onStateChange: (state: SecureInputState) -> Unit = {}

  override val view: View = field

  init {
    field.onStateChange = { state -> onStateChange(state) }
  }
}
