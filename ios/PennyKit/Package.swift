// swift-tools-version:5.10
import PackageDescription

// PennyKit is shared by the PennyHost app and the PennyMessages iMessage extension.
//  - PennyCore: Base58, Borsh, NEP-366 delegate actions, RFC 8785 JSON, engine API client, device key store.
//  - PennyUI:   the Penny card (SwiftUI), dither art, crew marks, Geist fonts.
// Run the unit tests on a Mac with:  cd ios/PennyKit && swift test
let package = Package(
    name: "PennyKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PennyCore", targets: ["PennyCore"]),
        .library(name: "PennyUI", targets: ["PennyUI"]),
    ],
    targets: [
        .target(name: "PennyCore"),
        .target(
            name: "PennyUI",
            dependencies: ["PennyCore"],
            resources: [.copy("Resources/Fonts")]
        ),
        .testTarget(
            name: "PennyCoreTests",
            dependencies: ["PennyCore"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
