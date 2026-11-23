package com.margelo.nitro.qntxwallet

import android.app.Activity
import android.util.Log
import androidx.activity.result.ActivityResult
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.Keep
import androidx.fragment.app.FragmentActivity
import com.facebook.proguard.annotations.DoNotStrip
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Task
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

/**
 * Google sign-in for `drive.appdata` access tokens (cloud backup): `accessToken(false)` is the
 * silent path — it rejects `auth-required` when Google needs a consent screen; `accessToken(true)`
 * launches that screen on the foreground activity. The token never enters a log: only exception
 * types and status codes are logged.
 */
@DoNotStrip
@Keep
class HybridGoogleDriveAuth : HybridGoogleDriveAuthSpec() {
  private val scope = Scope("https://www.googleapis.com/auth/drive.appdata")

  override fun accessToken(interactive: Boolean): Promise<String> = Promise.async {
    val context = NitroModules.applicationContext
      ?: throw cloudError("unavailable", "no-context")
    val request =
      AuthorizationRequest.builder().setRequestedScopes(listOf(scope)).build()
    val result = try {
      awaitTask(Identity.getAuthorizationClient(context).authorize(request))
    } catch (e: ApiException) {
      throw mapApiException(e)
    }
    val token = result.accessToken
    if (token != null) {
      return@async token
    }
    if (!result.hasResolution()) {
      throw cloudError("failed", "not-configured")
    }
    if (!interactive) {
      throw cloudError("auth-required", "needs-consent")
    }
    interactiveToken(result)
  }

  override fun clearToken(token: String): Promise<Unit> = Promise.async {
    val context = NitroModules.applicationContext
      ?: throw cloudError("unavailable", "no-context")
    try {
      awaitTask(
        Identity.getAuthorizationClient(context)
          .clearToken(ClearTokenRequest.builder().setToken(token).build())
      )
      Unit
    } catch (e: ApiException) {
      throw mapApiException(e)
    }
  }

  /** Launches the consent PendingIntent on the foreground activity and resolves the new token. */
  private suspend fun interactiveToken(result: AuthorizationResult): String {
    val activity = foregroundActivity() ?: throw cloudError("unavailable", "no-activity")
    val sender = result.pendingIntent?.intentSender
      ?: throw cloudError("failed", "not-configured")
    val granted: ActivityResult = suspendCoroutine { cont ->
      val key = "qntx-drive-auth-${UUID.randomUUID()}"
      // Registry access belongs on the main thread, so register and launch together there.
      activity.runOnUiThread {
        var launcher: ActivityResultLauncher<IntentSenderRequest>? = null
        try {
          launcher =
            activity.activityResultRegistry.register(
              key, ActivityResultContracts.StartIntentSenderForResult()
            ) { outcome ->
              launcher?.unregister()
              cont.resume(outcome)
            }
          launcher.launch(IntentSenderRequest.Builder(sender).build())
        } catch (e: Exception) {
          launcher?.unregister()
          cont.resumeWithException(cloudError("unavailable", "no-activity"))
        }
      }
    }
    if (granted.resultCode != Activity.RESULT_OK || granted.data == null) {
      throw cloudError("auth-required", "cancelled")
    }
    val authorized = try {
      Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(granted.data)
    } catch (e: ApiException) {
      throw mapApiException(e)
    }
    return authorized.accessToken ?: throw cloudError("failed", "no-token")
  }

  private fun foregroundActivity(): FragmentActivity? =
    NitroModules.applicationContext?.currentActivity as? FragmentActivity

  private fun mapApiException(e: ApiException): Exception {
    // Only the status code maps — the message can name the signed-in account.
    Log.w(TAG, "api failure: ${e.statusCode}")
    return when (e.statusCode) {
      CommonStatusCodes.NETWORK_ERROR -> cloudError("unavailable", "network")
      CommonStatusCodes.DEVELOPER_ERROR -> cloudError("failed", "not-configured")
      CommonStatusCodes.SIGN_IN_REQUIRED, CommonStatusCodes.RESOLUTION_REQUIRED ->
        cloudError("auth-required", "needs-consent")
      else -> cloudError("failed", "api-${e.statusCode}")
    }
  }

  private fun cloudError(code: String, detail: String): Exception =
    Exception("[qntx-cloud:$code] $detail")

  private suspend fun <T> awaitTask(task: Task<T>): T = suspendCoroutine { cont ->
    task.addOnCompleteListener { done ->
      if (done.isSuccessful) {
        cont.resume(done.result)
      } else {
        cont.resumeWithException(done.exception ?: Exception("task failed"))
      }
    }
  }

  private companion object {
    private const val TAG = "QntxDriveAuth"
  }
}
