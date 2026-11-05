import SwiftUI

/// Who is asking. Each crew member has a brand tile and a mark (brand/assets/*.svg, redrawn as paths).
public enum Crew: String, Sendable, CaseIterable {
    case penny, invest, mail, guardian, finance

    public var tile: Color {
        switch self {
        case .penny: return Color(hex: 0xFF6B2C)
        case .invest: return Color(hex: 0x6CCBFF)
        case .mail: return Color(hex: 0xFFE45C)
        case .guardian: return Color(hex: 0xF6A8F0)
        case .finance: return Color(hex: 0x5EE3A1)
        }
    }

    public var name: String {
        switch self {
        case .penny: return "Penny"
        case .invest: return "Invest"
        case .mail: return "Mail"
        case .guardian: return "Guard"
        case .finance: return "Finance"
        }
    }
}

/// 26pt circle on the crew tile with a 16pt mark, as on the cards.
public struct CrewChip: View {
    let crew: Crew
    var size: CGFloat = 26

    public init(_ crew: Crew, size: CGFloat = 26) {
        self.crew = crew
        self.size = size
    }

    public var body: some View {
        ZStack {
            Circle().fill(crew.tile)
            CrewMark(crew: crew).frame(width: size * 16 / 26, height: size * 16 / 26)
        }
        .frame(width: size, height: size)
        .accessibilityLabel(Text(crew.name))
    }
}

/// The SVG marks drawn in their 512×512 viewBox and scaled to fit.
public struct CrewMark: View {
    let crew: Crew

    public init(crew: Crew) { self.crew = crew }

    public var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 512
            context.translateBy(x: (size.width - 512 * scale) / 2, y: (size.height - 512 * scale) / 2)
            context.scaleBy(x: scale, y: scale)
            draw(in: &context)
        }
    }

    private static let ink = Color(hex: 0x111519)

    private func eyes(y: CGFloat, x1: CGFloat, x2: CGFloat) -> Path {
        var p = Path()
        p.addRoundedRect(in: CGRect(x: x1, y: y, width: 42, height: 92), cornerSize: CGSize(width: 21, height: 21))
        p.addRoundedRect(in: CGRect(x: x2, y: y, width: 42, height: 92), cornerSize: CGSize(width: 21, height: 21))
        return p
    }

    private func draw(in context: inout GraphicsContext) {
        switch crew {
        case .penny:
            // penny-white.svg: white "P" body with dark eyes.
            var body = Path()
            body.addEllipse(in: CGRect(x: 290 - 158, y: 216 - 158, width: 316, height: 316))
            body.move(to: CGPoint(x: 132, y: 216))
            body.addLine(to: CGPoint(x: 132, y: 404))
            body.addCurve(to: CGPoint(x: 188, y: 460), control1: CGPoint(x: 132, y: 438), control2: CGPoint(x: 158, y: 460))
            body.addCurve(to: CGPoint(x: 244, y: 404), control1: CGPoint(x: 218, y: 460), control2: CGPoint(x: 244, y: 438))
            body.addLine(to: CGPoint(x: 244, y: 340))
            body.addCurve(to: CGPoint(x: 160, y: 270), control1: CGPoint(x: 210, y: 330), control2: CGPoint(x: 180, y: 300))
            body.closeSubpath()
            body.addRect(CGRect(x: 132, y: 216, width: 120, height: 134))
            context.fill(body, with: .color(.white))
            context.fill(eyes(y: 154, x1: 247, x2: 331), with: .color(Self.ink))

        case .invest:
            var body = Path()
            body.move(to: CGPoint(x: 256, y: 70))
            body.addCurve(to: CGPoint(x: 302, y: 100), control1: CGPoint(x: 276, y: 70), control2: CGPoint(x: 290, y: 82))
            body.addLine(to: CGPoint(x: 452, y: 352))
            body.addCurve(to: CGPoint(x: 400, y: 444), control1: CGPoint(x: 478, y: 396), control2: CGPoint(x: 452, y: 444))
            body.addLine(to: CGPoint(x: 112, y: 444))
            body.addCurve(to: CGPoint(x: 60, y: 352), control1: CGPoint(x: 60, y: 444), control2: CGPoint(x: 34, y: 396))
            body.addLine(to: CGPoint(x: 210, y: 100))
            body.addCurve(to: CGPoint(x: 256, y: 70), control1: CGPoint(x: 222, y: 82), control2: CGPoint(x: 236, y: 70))
            body.closeSubpath()
            context.fill(body, with: .color(Self.ink))
            context.fill(eyes(y: 274, x1: 193, x2: 277), with: .color(.white))

        case .guardian:
            var body = Path()
            body.move(to: CGPoint(x: 256, y: 64))
            body.addCurve(to: CGPoint(x: 430, y: 110), control1: CGPoint(x: 320, y: 96), control2: CGPoint(x: 380, y: 108))
            body.addCurve(to: CGPoint(x: 256, y: 452), control1: CGPoint(x: 430, y: 290), control2: CGPoint(x: 380, y: 390))
            body.addCurve(to: CGPoint(x: 82, y: 110), control1: CGPoint(x: 132, y: 390), control2: CGPoint(x: 82, y: 290))
            body.addCurve(to: CGPoint(x: 256, y: 64), control1: CGPoint(x: 132, y: 108), control2: CGPoint(x: 192, y: 96))
            body.closeSubpath()
            context.fill(body, with: .color(Self.ink))
            context.fill(eyes(y: 190, x1: 193, x2: 277), with: .color(.white))

        case .mail:
            var body = Path()
            body.move(to: CGPoint(x: 96, y: 150))
            body.addQuadCurve(to: CGPoint(x: 136, y: 110), control: CGPoint(x: 96, y: 110))
            body.addLine(to: CGPoint(x: 376, y: 110))
            body.addQuadCurve(to: CGPoint(x: 416, y: 150), control: CGPoint(x: 416, y: 110))
            body.addLine(to: CGPoint(x: 416, y: 362))
            body.addQuadCurve(to: CGPoint(x: 376, y: 402), control: CGPoint(x: 416, y: 402))
            body.addLine(to: CGPoint(x: 136, y: 402))
            body.addQuadCurve(to: CGPoint(x: 96, y: 362), control: CGPoint(x: 96, y: 402))
            body.closeSubpath()
            context.fill(body, with: .color(Self.ink))
            var flap = Path()
            flap.move(to: CGPoint(x: 136, y: 150))
            flap.addLine(to: CGPoint(x: 256, y: 222))
            flap.addLine(to: CGPoint(x: 376, y: 150))
            context.stroke(flap, with: .color(Crew.mail.tile), style: StrokeStyle(lineWidth: 18, lineCap: .round, lineJoin: .round))
            context.fill(eyes(y: 264, x1: 193, x2: 277), with: .color(.white))

        case .finance:
            let body = Path(roundedRect: CGRect(x: 78, y: 96, width: 356, height: 330), cornerRadius: 110)
            context.fill(body, with: .color(Self.ink))
            context.fill(eyes(y: 216, x1: 193, x2: 277), with: .color(.white))
        }
    }
}
