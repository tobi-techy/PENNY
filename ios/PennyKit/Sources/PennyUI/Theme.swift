import CoreText
import Foundation
import SwiftUI

// Tokens from design/card/family.html + card.html (Reflect-dark card system).

extension Color {
    public init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

public enum PennyColor {
    public static let cardBackground = Color(hex: 0x080D14)
    public static let border = Color(hex: 0x1E2A38)
    public static let text = Color(hex: 0xF1F5FA)
    public static let meta = Color(hex: 0xB1C3D8)
    public static let hairline = Color.white.opacity(0.10)
    public static let hairlineSoft = Color.white.opacity(0.07)
    public static let ink = Color(hex: 0x111519)
    public static let track = Color(hex: 0x1E2A38)
    public static let pillDim = Color.white.opacity(0.12)
    public static let okBackground = Color(hex: 0x0A2E27)
    public static let okText = Color(hex: 0x8FE4CC)
    public static let stepDone = Color(hex: 0x008773)
    public static let stepActive = Color(hex: 0x3B7DC4)
    public static let optionSelected = Color(hex: 0x0E1A2A)
    public static let errorText = Color(hex: 0xFF9C9C)
}

/// Art colour + tag background + tag text, per card type.
public struct CardPalette: Equatable, Sendable {
    public let art: Color
    public let tagBackground: Color
    public let tagText: Color

    public static let blue = CardPalette(art: Color(hex: 0x6EA1D6), tagBackground: Color(hex: 0x0E2238), tagText: Color(hex: 0xA9C8EA))
    public static let green = CardPalette(art: Color(hex: 0x4FD57F), tagBackground: Color(hex: 0x0A2E1C), tagText: Color(hex: 0x8FE4B0))
    public static let orange = CardPalette(art: Color(hex: 0xFEA247), tagBackground: Color(hex: 0x33210B), tagText: Color(hex: 0xFFC98E))
    public static let purple = CardPalette(art: Color(hex: 0xB77DF8), tagBackground: Color(hex: 0x24163A), tagText: Color(hex: 0xD4B3FB))
    public static let pink = CardPalette(art: Color(hex: 0xFA78B2), tagBackground: Color(hex: 0x3A1428), tagText: Color(hex: 0xFBB3D3))
    public static let red = CardPalette(art: Color(hex: 0xFC5855), tagBackground: Color(hex: 0x3A1214), tagText: Color(hex: 0xFF9C9C))
    public static let mint = CardPalette(art: Color(hex: 0x8FE4CC), tagBackground: Color(hex: 0x0A2E27), tagText: Color(hex: 0x8FE4CC))
    public static let indigo = CardPalette(art: Color(hex: 0x8B8CF0), tagBackground: Color(hex: 0x1B1B3A), tagText: Color(hex: 0xBEBFFA))
    public static let amber = CardPalette(art: Color(hex: 0xE8C766), tagBackground: Color(hex: 0x2E2508), tagText: Color(hex: 0xF3DD9C))
    public static let muted = CardPalette(art: Color(hex: 0x4A5A6C), tagBackground: Color(hex: 0x151D27), tagText: Color(hex: 0xB1C3D8))
}

// MARK: - Fonts

public enum PennyFonts {
    private static let registered: Bool = {
        guard let folder = Bundle.module.url(forResource: "Fonts", withExtension: nil),
              let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else {
            return false
        }
        for file in files where ["otf", "ttf"].contains(file.pathExtension.lowercased()) {
            CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil)
        }
        return true
    }()

    /// Call once at launch (host app) and in the extension's viewDidLoad. Safe to call repeatedly.
    @discardableResult
    public static func register() -> Bool { registered }
}

extension Font {
    /// Geist at a fixed size (cards keep their designed proportions inside the transcript bubble).
    public static func geist(_ size: CGFloat, medium: Bool = false) -> Font {
        _ = PennyFonts.register()
        return .custom(medium ? "Geist-Medium" : "Geist-Regular", fixedSize: size)
    }

    /// Geist Mono at a fixed size, for tags, timers and small labels.
    public static func geistMono(_ size: CGFloat, medium: Bool = false) -> Font {
        _ = PennyFonts.register()
        return .custom(medium ? "GeistMono-Medium" : "GeistMono-Regular", fixedSize: size)
    }

    /// Geist that scales with Dynamic Type (host app screens).
    public static func geistScaled(_ size: CGFloat, medium: Bool = false, relativeTo style: Font.TextStyle = .body) -> Font {
        _ = PennyFonts.register()
        return .custom(medium ? "Geist-Medium" : "Geist-Regular", size: size, relativeTo: style)
    }
}
