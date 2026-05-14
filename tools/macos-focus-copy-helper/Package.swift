// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "MacOSFocusCopyHelper",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(
            name: "MacOSFocusCopyHelper",
            targets: ["MacOSFocusCopyHelper"]
        )
    ],
    targets: [
        .executableTarget(
            name: "MacOSFocusCopyHelper"
        )
    ]
)
