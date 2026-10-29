package com.margelo.nitro.qntxwallet

import android.content.Context
import java.io.File

/**
 * Vault directory hook: `<noBackupFilesDir>/qntx-wallet`, created at module
 * init and handed to C++ once — `noBackupFilesDir` needs a Context, which only
 * exists on the Java side.
 */
object KernelFileModule {
  @JvmStatic
  external fun setVaultDirectory(path: String)

  @JvmStatic
  fun init(context: Context) {
    val dir = File(context.noBackupFilesDir, "qntx-wallet")
    dir.mkdirs()
    setVaultDirectory(dir.absolutePath)
  }
}
