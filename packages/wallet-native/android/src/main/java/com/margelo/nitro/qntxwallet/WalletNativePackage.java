package com.margelo.nitro.qntxwallet;

import androidx.annotation.Nullable;

import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.model.ReactModuleInfoProvider;
import com.facebook.react.BaseReactPackage;

import java.util.HashMap;

public class WalletNativePackage extends BaseReactPackage {
  @Nullable
  @Override
  public NativeModule getModule(String name, ReactApplicationContext reactContext) {
    return null;
  }

  @Override
  public ReactModuleInfoProvider getReactModuleInfoProvider() {
    return () -> {
        return new HashMap<>();
    };
  }

  static {
    WalletNativeOnLoad.initializeNative();
  }

  @Override
  public java.util.List<NativeModule> createNativeModules(ReactApplicationContext reactContext) {
    // Vault directory hook: <noBackupFilesDir>/qntx-wallet — needs a Context,
    // which only exists once ReactContext creation hands it over.
    KernelFileModule.init(reactContext);
    return super.createNativeModules(reactContext);
  }
}
