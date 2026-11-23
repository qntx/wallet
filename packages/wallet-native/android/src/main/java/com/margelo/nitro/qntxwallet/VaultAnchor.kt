package com.margelo.nitro.qntxwallet

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import java.security.KeyStore
import javax.crypto.KeyGenerator

/**
 * Android vault anchor: the record lives in Android Keystore entry *aliases*
 * `qntx-wallet.anchor.<seq as 16 lowercase hex>.<record as lowercase hex>` —
 * the platform gives an app no keystore byte store or monotonic counter of its
 * own (rollback resistance inside key blobs is platform-only and @hide), and
 * keystore2's database sits outside the app's data directory and is not
 * backed up. `store` writes under the next
 * sequence alias, then deletes every other anchor alias: a crash between the
 * two leaves both, and the higher sequence wins. The key material is never
 * used — only the alias carries data — so entries are plain AES-128 keys with
 * no user authentication and no StrongBox. The prefix differs from the factor
 * keys' `qntx-wallet.vault.` so `Keystore.clear()` never deletes the anchor.
 */
@DoNotStrip
@Keep
object VaultAnchor {
  private const val PREFIX = "qntx-wallet.anchor."
  private const val PROVIDER = "AndroidKeyStore"
  private val ALIAS =
      Regex("^${Regex.escape(PREFIX)}([0-9a-f]{16})\\.((?:[0-9a-f]{2})+)$")

  private fun keyStore(): KeyStore =
      KeyStore.getInstance(PROVIDER).apply { load(null) }

  /** Highest sequence + record of every well-formed anchor alias; malformed
   * aliases with the prefix are corruption, not a miss. */
  private fun highest(store: KeyStore): Pair<ULong, ByteArray>? {
    var best: Pair<ULong, ByteArray>? = null
    for (alias in store.aliases().toList()) {
      if (!alias.startsWith(PREFIX)) {
        continue
      }
      val match = ALIAS.matchEntire(alias)
          ?: throw IllegalStateException("malformed vault anchor alias")
      val seq = match.groupValues[1].toULong(16)
      if (best == null || seq > best.first) {
        best = seq to match.groupValues[2].chunked(2)
            .map { it.toInt(16).toByte() }
            .toByteArray()
      }
    }
    return best
  }

  /** The current anchor record, or null when nothing is stored. */
  @JvmStatic
  @DoNotStrip
  @Keep
  fun load(): ByteArray? = highest(keyStore())?.second

  /**
   * Store `bytes` under the next sequence alias, then delete every other
   * anchor alias. Callers serialize under the C++ CAS mutex, so the
   * scan-then-write here cannot race itself.
   */
  @JvmStatic
  @DoNotStrip
  @Keep
  fun store(bytes: ByteArray) {
    val store = keyStore()
    val seq = when (val top = highest(store)?.first) {
      null -> 0uL
      ULong.MAX_VALUE ->
          throw IllegalStateException("vault anchor sequence exhausted")
      else -> top + 1uL
    }
    val alias = PREFIX + seq.toString(16).padStart(16, '0') + "." +
        bytes.joinToString("") { "%02x".format(it) }
    val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT)
        .setKeySize(128)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build()
    KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        .apply { init(spec) }
        .generateKey()
    store.aliases().toList()
        .filter { it.startsWith(PREFIX) && it != alias }
        .forEach(store::deleteEntry)
  }
}
