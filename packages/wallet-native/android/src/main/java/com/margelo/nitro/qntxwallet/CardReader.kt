package com.margelo.nitro.qntxwallet

import android.app.Activity
import android.app.Dialog
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.method.ScrollingMovementMethod
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import java.io.IOException
import java.util.concurrent.Executors

/**
 * The module's own trusted card surface: reader mode has no system UI (A3), so
 * open() shows a CardSheet carrying the kernel's prompt and a Cancel button
 * while NFC reader mode polls for the card. Session logic runs on a single
 * worker thread; the dialog and reader-mode switches run on the main thread.
 * Status ints are the CardReaderStatus contract shared with
 * CardReaderAndroid.cpp. Prompts, APDUs and responses are never logged.
 */
@DoNotStrip
@Keep
object CardReader {
  private const val OK = 0
  private const val CANCELLED = 1
  private const val TAG_LOST = 3
  private const val INTERRUPTED = 4
  private const val UNAVAILABLE = 5

  // qntx cards are ISO 14443-A; NDEF and the platform sound are noise (A6).
  private const val READER_FLAGS =
    NfcAdapter.FLAG_READER_NFC_A or
      NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or
      NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS

  // protocol.md §16.6: the card's slowest command may take 1.5 s on the wire.
  private const val ISO_DEP_TIMEOUT_MS = 5000

  // How long the kernel's closing text stays up before the sheet dismisses.
  private const val END_TEXT_DELAY_MS = 1500L

  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()

  // Touched on `worker` only. `session` is the live session; `ended` is the
  // status a dead session left for the next transmit (host contract).
  private var session: Session? = null
  private var endedStatus = UNAVAILABLE
  private var endedDetail: String? = null

  // `closed` and `sheet` cross the worker/main boundary; the rest is
  // worker-only.
  private class Session(
    val token: Long,
    val activity: Activity,
    val adapter: NfcAdapter,
  ) {
    @Volatile var sheet: CardSheet? = null
    var isoDep: IsoDep? = null
    var txToken: Long = -1L
    var readerOn = false
    @Volatile var closed = false
  }

  @JvmStatic
  fun open(token: Long, prompt: String) {
    worker.execute {
      if (session != null) {
        // The kernel serializes opens; keep the completion contract anyway.
        return@execute nativeComplete(token, UNAVAILABLE, null, "android:busy")
      }
      val activity = NitroModules.applicationContext?.currentActivity
        ?: return@execute nativeComplete(token, UNAVAILABLE, null, "android:no-activity")
      val adapter = NfcAdapter.getDefaultAdapter(activity)
        ?: return@execute nativeComplete(token, UNAVAILABLE, null, "android:no-nfc")
      if (!adapter.isEnabled) {
        return@execute nativeComplete(token, UNAVAILABLE, null, "android:nfc-disabled")
      }
      endedStatus = UNAVAILABLE
      endedDetail = null
      // The session record exists before the sheet so a close() queued
      // behind this open cannot slip past it.
      val session = Session(token, activity, adapter)
      this@CardReader.session = session
      main.post {
        if (session.closed || activity.isFinishing || activity.isDestroyed) {
          return@post // closed sessions are already settled; a dead
          // activity can never show the sheet
        }
        val sheet = CardSheet(activity)
        session.sheet = sheet
        sheet.onCancel = { worker.execute { endSession(session, CANCELLED, null) } }
        sheet.onFocusChange = { hasFocus ->
          worker.execute {
            if (this@CardReader.session !== session || session.closed) return@execute
            if (hasFocus) {
              if (!session.readerOn) {
                session.readerOn = true
                main.post {
                  if (session.closed) return@post
                  adapter.enableReaderMode(
                    activity,
                    { tag -> worker.execute { onTag(session, tag) } },
                    READER_FLAGS,
                    null,
                  )
                }
              }
            } else {
              // An overlay or the pause of the activity took the window's
              // focus: the surface is no longer trusted (A7), so the session
              // ends before another APDU could run uncovered.
              endSession(session, INTERRUPTED, "android:focus-lost")
            }
          }
        }
        sheet.showPrompt(prompt)
        sheet.show()
        if (session.closed) dismissSheet(session)
      }
    }
  }

  @JvmStatic
  fun transmit(token: Long, apdu: ByteArray) {
    worker.execute {
      val session = session
      if (session == null) {
        // A session end with no transmit in flight fails the next transmit
        // with the end's status (CardReader.hpp contract).
        return@execute nativeComplete(token, endedStatus, null, endedDetail)
      }
      val isoDep = session.isoDep
      if (isoDep == null || session.txToken >= 0) {
        return@execute nativeComplete(token, UNAVAILABLE, null, "android:busy")
      }
      session.txToken = token
      try {
        val response = isoDep.transceive(apdu)
        session.txToken = -1L
        nativeComplete(token, OK, response, null)
      } catch (e: IOException) {
        endSession(session, TAG_LOST, detailOf(e))
      } catch (e: SecurityException) {
        endSession(session, TAG_LOST, detailOf(e))
      }
    }
  }

  @JvmStatic
  fun close(success: Boolean, text: String) {
    worker.execute {
      val session = session ?: return@execute
      this@CardReader.session = null
      session.closed = true
      if (session.isoDep == null) {
        nativeComplete(session.token, CANCELLED, null, null)
      }
      if (session.txToken >= 0) {
        nativeComplete(session.txToken, CANCELLED, null, null)
      }
      try {
        session.isoDep?.close()
      } catch (_: IOException) {
        // The session is over either way.
      }
      main.post {
        val activity = session.activity
        if (!activity.isFinishing && !activity.isDestroyed) {
          session.adapter.disableReaderMode(activity)
        }
        val sheet = session.sheet
        if (sheet == null) {
          return@post
        }
        if (text.isEmpty()) {
          dismissSheet(session)
        } else {
          sheet.showEnd(text)
          main.postDelayed({ dismissSheet(session) }, END_TEXT_DELAY_MS)
        }
      }
    }
  }

  private fun onTag(session: Session, tag: Tag) {
    if (this.session !== session || session.isoDep != null) return
    val isoDep = IsoDep.get(tag) ?: return // not ISO-DEP: keep polling
    try {
      isoDep.connect()
      isoDep.timeout = ISO_DEP_TIMEOUT_MS
    } catch (e: IOException) {
      return endSession(session, TAG_LOST, detailOf(e))
    } catch (e: SecurityException) {
      return endSession(session, TAG_LOST, detailOf(e))
    }
    session.isoDep = isoDep
    nativeComplete(session.token, OK, null, null)
  }

  // Every failure ends the session, silently: pending calls get the status,
  // the sheet goes away, and the next transmit answers from `ended`.
  private fun endSession(session: Session, status: Int, detail: String?) {
    if (this.session !== session) return
    this.session = null
    session.closed = true
    endedStatus = status
    endedDetail = detail
    if (session.isoDep == null) {
      nativeComplete(session.token, status, null, detail)
    }
    if (session.txToken >= 0) {
      nativeComplete(session.txToken, status, null, detail)
    }
    try {
      session.isoDep?.close()
    } catch (_: IOException) {
      // The session is over either way.
    }
    main.post {
      val activity = session.activity
      if (!activity.isFinishing && !activity.isDestroyed) {
        session.adapter.disableReaderMode(activity)
      }
      dismissSheet(session)
    }
  }

  // The sheet's window may already be gone when a late close or session
  // end reaches the main thread.
  private fun dismissSheet(session: Session) {
    val sheet = session.sheet ?: return
    val activity = session.activity
    if (sheet.isShowing && !activity.isFinishing && !activity.isDestroyed) {
      sheet.dismiss()
    }
  }

  // The exception's simple class name only — never its message.
  private fun detailOf(e: Exception): String = "android:" + e.javaClass.simpleName

  @JvmStatic
  private external fun nativeComplete(
    token: Long,
    status: Int,
    response: ByteArray?,
    detail: String?,
  )
}

/**
 * The trusted reader dialog: the kernel's prompt text (scrollable, never
 * truncated) and a Cancel button. Touch filtering rejects clicks an overlay
 * could have produced (A9), `setHideOverlayWindows` keeps overlays off the
 * window (A8), and focus changes drive reader mode — polling only runs while
 * this window has focus.
 */
private class CardSheet(activity: Activity) : Dialog(activity) {
  var onCancel: (() -> Unit)? = null
  var onFocusChange: ((Boolean) -> Unit)? = null

  private val text = TextView(activity).apply {
    movementMethod = ScrollingMovementMethod()
    maxLines = 10
  }
  private val cancel = Button(activity).apply {
    setText(android.R.string.cancel)
    filterTouchesWhenObscured = true
    setOnClickListener { cancel() }
  }
  private val content = object : LinearLayout(activity) {
    init {
      orientation = VERTICAL
      val pad = (20 * resources.displayMetrics.density).toInt()
      setPadding(pad, pad, pad, pad)
    }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
      super.onWindowFocusChanged(hasWindowFocus)
      onFocusChange?.invoke(hasWindowFocus)
    }
  }

  init {
    setCanceledOnTouchOutside(false)
    setOnCancelListener { onCancel?.invoke() }
    content.addView(
      text,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
    )
    content.addView(cancel)
    setContentView(content)
    if (Build.VERSION.SDK_INT >= 31) {
      window?.setHideOverlayWindows(true)
    }
  }

  fun showPrompt(prompt: String) {
    text.text = prompt
  }

  fun showEnd(text: String) {
    this.text.text = text
    cancel.visibility = View.GONE
  }
}
