require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "WalletNative"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://github.com/qntx/wallet"
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/qntx/wallet.git" }
  # Swift pods (V1Probe's Nitrogen bridge) depend on this — a module map is required.
  s.static_framework = true

  s.source_files = [
    "cpp/runtime/**/*.{h,hpp,c,cpp,mm}",
    "cpp/host/**/*.{h,hpp,c,cpp,mm}",
    "cpp/platform/**/*.{h,hpp,c,cpp,mm}",
  ]
  s.public_header_files = "cpp/**/*.hpp"
  s.header_mappings_dir = "cpp"

  s.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
    "HEADER_SEARCH_PATHS" => [
      '"$(PODS_TARGET_SRCROOT)/cpp"',
      '"$(PODS_ROOT)/hermes-engine/destroot/include"',
      '"$(PODS_ROOT)/Headers/Private/SparkNative"',
      '"$(DERIVED_FILE_DIR)/qntx-kernel"',
    ].join(' '),
  }

  # Compile the shipped kernel-entry.js to bytecode with the app's own hermesc —
  # Hermes only loads its own bytecode version, so precompiled hbc cannot ship.
  # kernel.hpp lands in DERIVED_FILE_DIR/qntx-kernel (a header search path).
  s.script_phase = {
    :name => "Compile Kernel Bytecode",
    :script => <<~SH,
      if [ -z "$REACT_NATIVE_PATH" ]; then
        echo "REACT_NATIVE_PATH is not set"
        exit 1
      fi
      . "$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh"
      "$NODE_BINARY" "$PODS_TARGET_SRCROOT/scripts/compile-kernel.mjs" \
        "$DERIVED_FILE_DIR/qntx-kernel" "$REACT_NATIVE_PATH"
    SH
    :execution_position => :before_compile,
    :input_files => [
      "$(PODS_TARGET_SRCROOT)/kernel/generated/kernel-entry.js",
      "$(PODS_TARGET_SRCROOT)/kernel/generated/kernel.manifest.json",
      "$(PODS_TARGET_SRCROOT)/scripts/compile-kernel.mjs",
    ],
    :output_files => ["$(DERIVED_FILE_DIR)/qntx-kernel/kernel.hpp"],
  }

  # The kernel's backends.spark binds the qs_* C ABI; the prebuilt
  # QntxSpark.xcframework ships inside the SparkNative pod.
  s.dependency 'SparkNative'
  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  s.dependency 'React-hermes'
  s.dependency 'hermes-engine'

  load 'nitrogen/generated/ios/WalletNative+autolinking.rb'
  add_nitrogen_files(s)
  install_modules_dependencies(s)
end
