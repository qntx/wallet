package com.margelo.nitro.qntxwallet;

import androidx.annotation.Nullable;

import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.model.ReactModuleInfoProvider;
import com.facebook.react.uimanager.ViewManager;
import com.facebook.react.BaseReactPackage;

import com.margelo.nitro.qntxwallet.views.HybridSecureInputViewManager;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;

public class WalletNativePackage extends BaseReactPackage {
  @Nullable
  @Override
  public NativeModule getModule(String name, ReactApplicationContext reactContext) {
    return null;
  }

  @Override
  public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
    return Arrays.asList(new HybridSecureInputViewManager());
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

}
