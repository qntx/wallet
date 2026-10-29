package com.margelo.nitro.qntxwallet

import android.os.Handler
import android.os.Looper
import androidx.annotation.Keep
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.facebook.proguard.annotations.DoNotStrip

/**
 * Process-wide lifecycle: the C++ host calls [install] once (fbjni, first
 * KernelHost.start); the observer forwards app background/foreground
 * transitions to the native dispatcher on the main looper.
 */
@DoNotStrip
@Keep
object AppLifecycle {

    @JvmStatic
    fun install() {
        Handler(Looper.getMainLooper()).post {
            ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
                override fun onStop(owner: LifecycleOwner) = onAppBackground()
                override fun onStart(owner: LifecycleOwner) = onAppForeground()
            })
        }
    }

    @JvmStatic
    private external fun onAppBackground()

    @JvmStatic
    private external fun onAppForeground()
}
