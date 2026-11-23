// swift-tools-version: 5.9
import PackageDescription

// Test-only package: runs the pure CloudKit backup logic in `ios/cloud` against a fake
// database under XCTest. It is not part of the npm tarball (`files` omits it) or the pod
// (the podspec only globs ios/**/*.swift and cpp/**).
let package = Package(
  name: "WalletNativeCloud",
  platforms: [.iOS(.v15), .macOS(.v12)],
  targets: [
    .target(name: "WalletNativeCloud", path: "ios/cloud"),
    .testTarget(
      name: "WalletNativeCloudTests",
      dependencies: ["WalletNativeCloud"],
      path: "tests/ios"
    ),
  ]
)
