package com.margelo.nitro.qntxwallet

import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.LocaleList
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import androidx.annotation.Keep
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Android keystore (W5): one AndroidKeyStore AES-256-GCM key per vault factor
 * (`qntx-wallet.vault.<factor id>`), StrongBox-backed when present. Every use
 * needs a fresh BiometricPrompt (strong biometric or device credential) bound
 * to the cipher through a CryptoObject; the key survives biometric enrollment
 * changes and dies with the lock screen. The C++ host calls these entry points
 * with a completion token and receives the result through [nativeComplete].
 * Sealed bytes are `iv(12) ‖ ciphertext ‖ tag(16)`.
 */
@DoNotStrip
@Keep
object Keystore {
  private const val PREFIX = "qntx-wallet.vault."
  private const val PROVIDER = "AndroidKeyStore"
  private const val TRANSFORMATION = "AES/GCM/NoPadding"
  private const val IV_BYTES = 12
  private const val TAG_BITS = 128

  // Status codes shared with KeystoreAndroid.cpp.
  private const val OK = 0
  private const val CANCELLED = 1
  private const val INVALIDATED = 2
  private const val UNAVAILABLE = 3
  private const val FAILED = 4

  @Volatile private var current: BiometricPrompt? = null

  @JvmStatic
  fun locale(): String = LocaleList.getDefault()[0]?.toLanguageTag() ?: "en"

  @JvmStatic
  fun seal(token: Long, id: String, secret: ByteArray, title: String, description: String) {
    val activity = foregroundActivity()
    if (activity == null || !deviceSecure(activity)) {
      secret.fill(0)
      return nativeComplete(token, UNAVAILABLE, null)
    }
    val alias = PREFIX + id
    val cipher = try {
      keyStore().deleteEntry(alias)
      Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, generate(alias, activity)) }
    } catch (e: Exception) {
      secret.fill(0)
      return nativeComplete(token, UNAVAILABLE, null)
    }
    prompt(activity, title, description, BiometricPrompt.CryptoObject(cipher)) { status, crypto ->
      try {
        val authenticated = crypto?.cipher
        if (status != OK || authenticated == null) {
          keyStore().deleteEntry(alias)
          nativeComplete(token, if (status == OK) FAILED else status, null)
        } else {
          nativeComplete(token, OK, authenticated.iv + authenticated.doFinal(secret))
        }
      } catch (e: Exception) {
        keyStore().deleteEntry(alias)
        nativeComplete(token, FAILED, null)
      } finally {
        secret.fill(0)
      }
    }
  }

  @JvmStatic
  fun open(token: Long, id: String, sealed: ByteArray, title: String, description: String) {
    val activity = foregroundActivity() ?: return nativeComplete(token, UNAVAILABLE, null)
    if (sealed.size <= IV_BYTES + TAG_BITS / 8) {
      return nativeComplete(token, FAILED, null)
    }
    val alias = PREFIX + id
    val key = try {
      keyStore().getKey(alias, null) as? SecretKey
    } catch (e: UnrecoverableKeyException) {
      null
    } ?: return nativeComplete(token, INVALIDATED, null)
    val cipher = try {
      Cipher.getInstance(TRANSFORMATION).apply {
        init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
      }
    } catch (e: KeyPermanentlyInvalidatedException) {
      keyStore().deleteEntry(alias)
      return nativeComplete(token, INVALIDATED, null)
    } catch (e: Exception) {
      return nativeComplete(token, FAILED, null)
    }
    prompt(activity, title, description, BiometricPrompt.CryptoObject(cipher)) { status, crypto ->
      val authenticated = crypto?.cipher
      if (status != OK || authenticated == null) {
        nativeComplete(token, if (status == OK) FAILED else status, null)
        return@prompt
      }
      val plain = try {
        authenticated.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
      } catch (e: Exception) {
        return@prompt nativeComplete(token, FAILED, null)
      }
      try {
        nativeComplete(token, OK, plain)
      } finally {
        plain.fill(0)
      }
    }
  }

  @JvmStatic
  fun authenticate(token: Long, title: String, description: String) {
    val activity = foregroundActivity()
    if (activity == null || !deviceSecure(activity)) {
      return nativeComplete(token, UNAVAILABLE, null)
    }
    prompt(activity, title, description, null) { status, _ -> nativeComplete(token, status, null) }
  }

  @JvmStatic
  fun clear(token: Long) {
    val status = try {
      val store = keyStore()
      store.aliases().toList().filter { it.startsWith(PREFIX) }.forEach(store::deleteEntry)
      OK
    } catch (e: Exception) {
      FAILED
    }
    nativeComplete(token, status, null)
  }

  @JvmStatic
  fun cancel() {
    val activity = foregroundActivity() ?: return
    ContextCompat.getMainExecutor(activity).execute { current?.cancelAuthentication() }
  }

  private fun foregroundActivity(): FragmentActivity? =
    NitroModules.applicationContext?.currentActivity as? FragmentActivity

  private fun deviceSecure(context: Context): Boolean =
    context.getSystemService(KeyguardManager::class.java)?.isDeviceSecure == true

  private fun keyStore(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

  private fun generate(alias: String, context: Context): SecretKey {
    val strongBox = context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
    return try {
      generate(alias, strongBox)
    } catch (e: StrongBoxUnavailableException) {
      generate(alias, false)
    }
  }

  private fun generate(alias: String, strongBox: Boolean): SecretKey {
    val spec = KeyGenParameterSpec.Builder(
      alias,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setUserAuthenticationRequired(true)
      .setUserAuthenticationParameters(
        0,
        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
      )
      .setUnlockedDeviceRequired(true)
      .setInvalidatedByBiometricEnrollment(false)
      .setIsStrongBoxBacked(strongBox)
      .build()
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
      .apply { init(spec) }
      .generateKey()
  }

  /** Shows one system verification on the main thread; [done] runs there with the outcome. */
  private fun prompt(
    activity: FragmentActivity,
    title: String,
    description: String,
    crypto: BiometricPrompt.CryptoObject?,
    done: (Int, BiometricPrompt.CryptoObject?) -> Unit,
  ) {
    val executor = ContextCompat.getMainExecutor(activity)
    executor.execute {
      val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle(title)
        .setDescription(description)
        .setAllowedAuthenticators(BIOMETRIC_STRONG or DEVICE_CREDENTIAL)
        .build()
      val biometricPrompt = BiometricPrompt(
        activity,
        executor,
        object : BiometricPrompt.AuthenticationCallback() {
          override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            current = null
            done(OK, result.cryptoObject)
          }

          override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            current = null
            done(statusOf(errorCode), null)
          }
        },
      )
      current = biometricPrompt
      try {
        if (crypto == null) biometricPrompt.authenticate(info) else biometricPrompt.authenticate(info, crypto)
      } catch (e: Exception) {
        current = null
        done(FAILED, null)
      }
    }
  }

  private fun statusOf(errorCode: Int): Int = when (errorCode) {
    BiometricPrompt.ERROR_USER_CANCELED,
    BiometricPrompt.ERROR_NEGATIVE_BUTTON,
    BiometricPrompt.ERROR_CANCELED,
    BiometricPrompt.ERROR_TIMEOUT -> CANCELLED
    BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL,
    BiometricPrompt.ERROR_HW_UNAVAILABLE,
    BiometricPrompt.ERROR_HW_NOT_PRESENT,
    BiometricPrompt.ERROR_NO_BIOMETRICS -> UNAVAILABLE
    else -> FAILED
  }

  @JvmStatic
  private external fun nativeComplete(token: Long, status: Int, bytes: ByteArray?)
}
