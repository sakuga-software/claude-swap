// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CswapMenuBar",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "CswapMenuBar", targets: ["CswapMenuBar"]),
        .library(name: "CswapMenuBarCore", targets: ["CswapMenuBarCore"]),
    ],
    targets: [
        .target(name: "CswapMenuBarCore"),
        .executableTarget(
            name: "CswapMenuBar",
            dependencies: ["CswapMenuBarCore"]
        ),
        .testTarget(
            name: "CswapMenuBarCoreTests",
            dependencies: ["CswapMenuBarCore"]
        ),
    ]
)
