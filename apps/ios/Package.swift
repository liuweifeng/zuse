// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ZuseNative",
  platforms: [.iOS(.v18), .macOS(.v15)],
  products: [.library(name: "ZuseCore", targets: ["ZuseCore"])],
  targets: [
    .target(name: "ZuseCore"),
    .testTarget(name: "ZuseCoreTests", dependencies: ["ZuseCore"]),
  ]
)
