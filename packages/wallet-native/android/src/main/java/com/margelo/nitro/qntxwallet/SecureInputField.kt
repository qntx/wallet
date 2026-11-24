package com.margelo.nitro.qntxwallet

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Typeface
import android.os.Build
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.method.TransformationMethod
import android.view.ActionMode
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip

// SecureInputKind ordinals shared with cpp/host/SecureInput.hpp.
private const val KIND_ACCESS_CODE = 0
private const val KIND_SHORT_ID = 1
private const val KIND_BACKUP_PASSWORD = 2
private const val KIND_SESSION_APPROVAL = 3

/**
 * The Android half of the trusted input surface: a label the kernel sets
 * plus an EditText whose characters leave the process only as bytes through
 * SecureInputHub — never through the main runtime, which sees only state
 * transitions. The field is disabled until a request arms it.
 */
@DoNotStrip
@Keep
@SuppressLint("AppCompatCustomView")
class SecureInputField(context: Context) : LinearLayout(context) {
  var onStateChange: ((SecureInputState) -> Unit)? = null

  private val label = TextView(context)
  private val field = Field(context)

  private var hubId = 0L
  private var kind = KIND_ACCESS_CODE
  private var justSubmitted = false
  private var state = SecureInputState.IDLE
  private var secureSet = false
  private var hadSecureFlag = false
  private var disarming = false

  init {
    orientation = VERTICAL
    addView(label)
    addView(field)
    disarm()
  }

  override fun requestLayout() {
    super.requestLayout()
    // React Native owns this host view's frame and swallows child layout
    // requests, so a label going GONE→VISIBLE would never be measured.
    // Measure and lay out ourselves on the next main-loop pass.
    post {
      measure(
        MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
        MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
      )
      layout(left, top, right, bottom)
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (hubId == 0L) {
      hubId = nativeAttach()
    }
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    if (hubId != 0L) {
      nativeDetach(hubId)
      hubId = 0L
    }
    disarm()
  }

  // Invoked by the C++ hub sink on the kernel's thread — hop to the main
  // Looper before touching the views.
  @Keep
  fun deliver(kind: Int, labelText: String?) {
    post { applyPrompt(kind, labelText) }
  }

  private fun applyPrompt(kind: Int, labelText: String?) {
    if (labelText == null) {
      val submitted = justSubmitted
      justSubmitted = false
      disarm(submitted)
      return
    }
    justSubmitted = false
    this.kind = kind
    label.text = labelText
    arm()
  }

  private fun arm() {
    label.visibility = VISIBLE
    field.isEnabled = true
    field.inputType =
      when (kind) {
        KIND_SESSION_APPROVAL -> InputType.TYPE_CLASS_NUMBER
        KIND_SHORT_ID ->
          InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
            InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        else -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      }
    // Never reveal characters: PasswordTransformationMethod shows the last
    // typed char when the system setting is on — mask every char ourselves.
    // The readable kinds (short id, approval code) carry no secret: the label
    // itself shows the approval code.
    field.transformationMethod =
      if (kind == KIND_SHORT_ID || kind == KIND_SESSION_APPROVAL) {
        null
      } else {
        MaskTransformation
      }
    field.filters =
      when (kind) {
        KIND_ACCESS_CODE -> arrayOf(accessCodeFilter)
        KIND_BACKUP_PASSWORD -> arrayOf(backupPasswordFilter)
        KIND_SESSION_APPROVAL -> arrayOf(sessionApprovalFilter)
        else -> arrayOf(shortIdFilter)
      }
    field.typeface =
      if (kind == KIND_SHORT_ID || kind == KIND_SESSION_APPROVAL) {
        Typeface.MONOSPACE
      } else {
        Typeface.DEFAULT
      }
    if (kind != KIND_SHORT_ID && kind != KIND_SESSION_APPROVAL && !secureSet) {
      activityWindow()?.let { window ->
        hadSecureFlag =
          window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0
        // The entry is a secret; keep it off screenshots and untrusted
        // displays while it is being typed (S6).
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        secureSet = true
      }
    }
    emit(SecureInputState.EMPTY)
    // A mounted view that just armed takes the keyboard; the latest
    // attach wins over fields armed earlier.
    if (isAttachedToWindow) {
      field.requestFocus()
      showKeyboard()
    }
  }

  private fun disarm(submitted: Boolean = false) {
    // Editable content cannot be erased; overwrite it before clearing — the
    // best the platform can do. The overwrite fires the watcher, so
    // suppress it: the runtime sees (submitted then) idle, nothing else.
    disarming = true
    val text = field.text
    if (text.isNotEmpty()) {
      text.replace(0, text.length, "0".repeat(text.length))
    }
    text.clear()
    disarming = false
    field.isEnabled = false
    field.clearFocus()
    hideKeyboard()
    if (secureSet) {
      secureSet = false
      activityWindow()?.let { window ->
        if (hadSecureFlag) {
          window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
          window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
      }
    }
    label.text = null
    label.visibility = GONE
    if (submitted) {
      emit(SecureInputState.SUBMITTED)
    }
    emit(SecureInputState.IDLE)
  }

  private fun emit(next: SecureInputState) {
    if (state == next) return
    state = next
    onStateChange?.invoke(next)
  }

  private fun onTextChanged() {
    if (disarming) return
    emit(
      if (field.text.isEmpty()) SecureInputState.EMPTY else SecureInputState.FILLED,
    )
  }

  private fun submit() {
    val text = field.text
    val ready =
      when (kind) {
        KIND_SHORT_ID -> text.length == 8
        KIND_SESSION_APPROVAL -> text.length == 4
        else -> text.isNotEmpty()
      }
    if (!ready) return
    // The ASCII-only kinds are one char per byte; a backup password is
    // arbitrary Unicode, handed over as real UTF-8.
    val bytes =
      if (kind == KIND_BACKUP_PASSWORD) {
        text.toString().toByteArray(Charsets.UTF_8)
      } else {
        ByteArray(text.length) { i -> text[i].code.toByte() }
      }
    justSubmitted = nativeSubmit(hubId, bytes)
    if (!justSubmitted) {
      // The hub refused it; drop the local copy now too — its own clear
      // arrives on this queue right behind.
      text.clear()
      emit(SecureInputState.EMPTY)
    }
  }

  private fun activityWindow(): android.view.Window? {
    var context = context
    while (context is ContextWrapper) {
      if (context is Activity) return context.window
      context = context.baseContext
    }
    return null
  }

  private fun hideKeyboard() {
    val imm =
      context.getSystemService(Context.INPUT_METHOD_SERVICE)
        as android.view.inputmethod.InputMethodManager
    imm.hideSoftInputFromWindow(field.windowToken, 0)
  }

  private fun showKeyboard() {
    val imm =
      context.getSystemService(Context.INPUT_METHOD_SERVICE)
        as android.view.inputmethod.InputMethodManager
    imm.showSoftInput(field, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
  }

  @Keep
  private external fun nativeAttach(): Long

  @Keep
  private external fun nativeDetach(id: Long)

  @Keep
  private external fun nativeSubmit(id: Long, bytes: ByteArray): Boolean

  // The characters the transformation shows — dots only, one per char, so
  // the secret's glyphs never exist as a displayable String either. Like
  // PasswordCharSequence, it must delegate length to the live source: a
  // frozen snapshot leaves the Layout measuring offsets against a stale
  // length and the cursor-anchor notifier crashes ("Invalid Context
  // Range").
  private class Masked(private val source: CharSequence) : CharSequence {
    override val length: Int
      get() = source.length

    override fun get(index: Int): Char = '•'

    override fun subSequence(startIndex: Int, endIndex: Int): CharSequence =
      Masked(source.subSequence(startIndex, endIndex))
  }

  private object MaskTransformation : TransformationMethod {
    override fun getTransformation(source: CharSequence, view: View): CharSequence =
      Masked(source)

    override fun onFocusChanged(
      view: View,
      sourceText: CharSequence,
      focused: Boolean,
      direction: Int,
      previouslyFocusedRect: android.graphics.Rect?,
    ) {}
  }

  // An EditText that never offers the selection or insertion menus: the
  // main runtime can read the clipboard, so copy/paste is cut off in both
  // directions, and autofill and accessibility services get nothing (S8/S9).
  @SuppressLint("AppCompatCustomView")
  private inner class Field(context: Context) : EditText(context) {
    init {
      importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
      if (Build.VERSION.SDK_INT >= 34) {
        setAccessibilityDataSensitive(ACCESSIBILITY_DATA_SENSITIVE_YES)
      }
      isLongClickable = false
      imeOptions =
        EditorInfo.IME_ACTION_DONE or
          EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or
          EditorInfo.IME_FLAG_NO_EXTRACT_UI
      val noMenu =
        object : ActionMode.Callback {
          override fun onCreateActionMode(mode: ActionMode, menu: Menu) = false
          override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = false
          override fun onActionItemClicked(mode: ActionMode, item: MenuItem) = false
          override fun onDestroyActionMode(mode: ActionMode) {}
        }
      customSelectionActionModeCallback = noMenu
      customInsertionActionModeCallback = noMenu
      setOnEditorActionListener { _, actionId, event ->
        val done =
          actionId == EditorInfo.IME_ACTION_DONE ||
            (event?.keyCode == KeyEvent.KEYCODE_ENTER &&
              event.action == KeyEvent.ACTION_DOWN)
        if (done) submit()
        done
      }
      addTextChangedListener(
        object : android.text.TextWatcher {
          override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
          override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {
            this@SecureInputField.onTextChanged()
          }
          override fun afterTextChanged(s: Editable?) {}
        },
      )
    }
  }

  private companion object {
    // Returns the text the range keeps when an edit is refused: returning
    // the replaced span itself cancels the change without deleting it.
    private fun refuse(dest: CharSequence, dstart: Int, dend: Int): CharSequence =
      dest.subSequence(dstart, dend)

    val accessCodeFilter =
      InputFilter { source, start, end, dest, dstart, dend ->
        val next = dest.length - (dend - dstart) + (end - start)
        var allowed = next <= 64
        if (allowed) {
          for (i in start until end) {
            val c = source[i]
            if (c < ' ' || c > '~') {
              allowed = false
              break
            }
          }
        }
        if (allowed) null else refuse(dest, dstart, dend)
      }

    // Any characters, bounded by 1024 UTF-8 bytes — the wire's own limit;
    // the hub rechecks validity on submit.
    val backupPasswordFilter =
      InputFilter { source, start, end, dest, dstart, dend ->
        val next =
          StringBuilder(dest).replace(
            dstart,
            dend,
            source.subSequence(start, end).toString(),
          )
        if (next.toString().toByteArray(Charsets.UTF_8).size <= 1024) {
          null
        } else {
          refuse(dest, dstart, dend)
        }
      }

    // Decimal digits only, four at most.
    val sessionApprovalFilter =
      InputFilter { source, start, end, dest, dstart, dend ->
        val next = dest.length - (dend - dstart) + (end - start)
        var allowed = next <= 4
        if (allowed) {
          for (i in start until end) {
            if (source[i] !in '0'..'9') {
              allowed = false
              break
            }
          }
        }
        if (allowed) null else refuse(dest, dstart, dend)
      }

    val shortIdFilter =
      InputFilter { source, start, end, dest, dstart, dend ->
        val filtered = StringBuilder()
        var kept = dest.length - (dend - dstart)
        var allowed = true
        for (i in start until end) {
          var c = source[i]
          if (c == '-') continue
          if (c in 'a'..'f') c = c.uppercaseChar()
          if (!(c in '0'..'9' || c in 'A'..'F') || kept >= 8) {
            allowed = false
            break
          }
          filtered.append(c)
          kept++
        }
        if (!allowed) {
          refuse(dest, dstart, dend)
        } else if (filtered.toString() == source.subSequence(start, end).toString()) {
          null
        } else {
          filtered.toString()
        }
      }
  }
}
