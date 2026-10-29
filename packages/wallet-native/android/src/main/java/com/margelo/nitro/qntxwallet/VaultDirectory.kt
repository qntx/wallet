package com.margelo.nitro.qntxwallet

import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import java.io.File

/**
 * Vault directory hook: `<noBackupFilesDir>/qntx-wallet`, pulled from C++
 * through fbjni — `noBackupFilesDir` needs a Context, which Nitro hands us once
 * its TurboModule is constructed (before any `createHybridObject("KernelHost")`).
 */
object VaultDirectory {
  @JvmStatic
  @DoNotStrip
  @Keep
  fun resolve(): String {
    val context = NitroModules.applicationContext
        ?: throw IllegalStateException(
            "vault directory: NitroModules.applicationContext is not set")
    val dir = File(context.noBackupFilesDir, "qntx-wallet")
    dir.mkdirs()
    if (!dir.isDirectory) {
      throw IllegalStateException("vault directory: mkdirs failed")
    }
    return dir.absolutePath
  }
}
