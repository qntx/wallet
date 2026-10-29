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
    "cpp/generated/**/*.{h,hpp,c,cpp}",
  ]
  s.public_header_files = "cpp/**/*.hpp"
  s.header_mappings_dir = "cpp"

  s.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
    "HEADER_SEARCH_PATHS" => [
      '"$(PODS_TARGET_SRCROOT)/cpp"',
      '"$(PODS_ROOT)/hermes-engine/destroot/include"',
    ].join(' '),
  }

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  s.dependency 'React-hermes'
  s.dependency 'hermes-engine'

  load 'nitrogen/generated/ios/WalletNative+autolinking.rb'
  add_nitrogen_files(s)
  install_modules_dependencies(s)
end
