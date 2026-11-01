package com.margelo.nitro.qntxwallet

import android.os.CancellationSignal
import android.util.Log
import androidx.annotation.Keep
import androidx.core.content.ContextCompat
import androidx.credentials.CreateCredentialResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialNoCreateOptionException
import androidx.credentials.exceptions.CreateCredentialProviderConfigurationException
import androidx.credentials.exceptions.CreateCredentialUnsupportedException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import androidx.fragment.app.FragmentActivity
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules

/**
 * Android passkey authenticator (W6): Credential Manager with the kernel's
 * WebAuthn JSON. Requests and responses stay JSON — the kernel builds the
 * options (PRF eval included) and parses the response itself, so this object
 * only runs the system ceremony. The C++ host calls [create] and [get] with a
 * completion token and receives the outcome through [nativeComplete].
 */
@DoNotStrip
@Keep
object Passkey {
  // Status codes shared with PasskeyAndroid.cpp.
  private const val OK = 0
  private const val CANCELLED = 1
  private const val UNAVAILABLE = 3
  private const val FAILED = 4
  // The exception type only — never the message, which can name the account.
  private const val TAG = "QntxPasskey"

  @Volatile private var signal: CancellationSignal? = null

  @JvmStatic
  fun create(token: Long, requestJson: String) {
    val activity = foregroundActivity() ?: return nativeComplete(token, UNAVAILABLE, null)
    val cancel = CancellationSignal().also { signal = it }
    CredentialManager.create(activity).createCredentialAsync(
      activity,
      CreatePublicKeyCredentialRequest(requestJson),
      cancel,
      ContextCompat.getMainExecutor(activity),
      object : CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException> {
        override fun onResult(result: CreateCredentialResponse) {
          signal = null
          val response = result as? CreatePublicKeyCredentialResponse
          nativeComplete(
            token,
            if (response == null) FAILED else OK,
            response?.registrationResponseJson,
          )
        }

        override fun onError(e: CreateCredentialException) {
          signal = null
          Log.w(TAG, "create failed: ${e.type}")
          nativeComplete(token, statusOf(e), null)
        }
      },
    )
  }

  @JvmStatic
  fun get(token: Long, requestJson: String) {
    val activity = foregroundActivity() ?: return nativeComplete(token, UNAVAILABLE, null)
    val cancel = CancellationSignal().also { signal = it }
    CredentialManager.create(activity).getCredentialAsync(
      activity,
      GetCredentialRequest(listOf(GetPublicKeyCredentialOption(requestJson))),
      cancel,
      ContextCompat.getMainExecutor(activity),
      object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
        override fun onResult(result: GetCredentialResponse) {
          signal = null
          val credential = result.credential as? PublicKeyCredential
          nativeComplete(
            token,
            if (credential == null) FAILED else OK,
            credential?.authenticationResponseJson,
          )
        }

        override fun onError(e: GetCredentialException) {
          signal = null
          Log.w(TAG, "get failed: ${e.type}")
          nativeComplete(token, statusOf(e), null)
        }
      },
    )
  }

  @JvmStatic
  fun cancel() {
    signal?.cancel()
  }

  private fun foregroundActivity(): FragmentActivity? =
    NitroModules.applicationContext?.currentActivity as? FragmentActivity

  // NotAllowedError is what the platform reports when the user dismisses or
  // times out the sheet; SecurityError means the RP id is not associated
  // with this app (assetlinks), i.e. passkeys are unavailable here.
  private fun statusOf(e: CreateCredentialException): Int = when (e) {
    is CreateCredentialCancellationException -> CANCELLED
    is CreateCredentialNoCreateOptionException,
    is CreateCredentialProviderConfigurationException,
    is CreateCredentialUnsupportedException -> UNAVAILABLE
    is CreatePublicKeyCredentialDomException -> domStatus(e.type)
    else -> FAILED
  }

  private fun statusOf(e: GetCredentialException): Int = when (e) {
    is GetCredentialCancellationException -> CANCELLED
    is NoCredentialException,
    is GetCredentialProviderConfigurationException,
    is GetCredentialUnsupportedException -> UNAVAILABLE
    is GetPublicKeyCredentialDomException -> domStatus(e.type)
    else -> FAILED
  }

  private fun domStatus(type: String): Int = when {
    type.endsWith("NotAllowedError") -> CANCELLED
    type.endsWith("SecurityError") || type.endsWith("NotSupportedError") -> UNAVAILABLE
    else -> FAILED
  }

  @JvmStatic
  private external fun nativeComplete(token: Long, status: Int, responseJson: String?)
}
