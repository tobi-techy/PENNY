import SwiftUI

/// Penny's mood, which shapes the art: how tall the ridge is and whether it drifts.
public enum ArtMood: Sendable {
    case ask, working, calm, alarm, quiet

    var amplitude: Double {
        switch self {
        case .ask: return 0.24
        case .working: return 0.22
        case .calm: return 0.10
        case .alarm: return 0.30
        case .quiet: return 0.06
        }
    }

    var animated: Bool { self == .working }
}

/// Dithered (ordered Bayer 4×4) hill header, ported from the canvas in design/card/family.html.
public struct DitherArt: View {
    let color: Color
    let mood: ArtMood
    /// 0...1 horizontal position of the peak; varied per card so the family doesn't look stamped.
    let center: Double
    let phase: Double

    public init(color: Color, mood: ArtMood, center: Double = 0.6, phase: Double = 0) {
        self.color = color
        self.mood = mood
        self.center = center
        self.phase = phase
    }

    public var body: some View {
        if mood.animated {
            TimelineView(.animation(minimumInterval: 1.0 / 12.0)) { timeline in
                canvas(drift: timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 600) * 0.9)
            }
        } else {
            canvas(drift: 0)
        }
    }

    private static let bayer: [[Double]] = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]

    private func canvas(drift: Double) -> some View {
        let amplitude = mood.amplitude
        let center = self.center
        let phase = self.phase + drift
        let color = self.color
        return Canvas { context, size in
            let full = Path(CGRect(origin: .zero, size: size))
            context.fill(full, with: .color(PennyColor.cardBackground))

            let cell: CGFloat = 2      // 4 device px at 2x, as in the HTML
            let dot: CGFloat = 1.5
            let cols = max(1, Int(size.width / cell))
            let rows = max(1, Int(size.height / cell))
            var buckets = [Path](repeating: Path(), count: 4)

            for r in 0..<rows {
                let ny = Double(r) / Double(rows)
                for c in 0..<cols {
                    let nx = Double(c) / Double(cols)
                    let dx = nx - center
                    let ridge = 0.64 - amplitude * exp(-(dx * dx) / 0.05) - 0.07 * sin(nx * 8 + phase)
                    var v: Double
                    if ny > ridge {
                        v = 0.85 - (ny - ridge) * 1.2
                    } else {
                        let d = ny - ridge
                        v = 0.16 * exp(-(d * d) / 0.004)
                    }
                    v *= 0.35 + 0.65 * exp(-(dx * dx) / 0.14)
                    let threshold = (Self.bayer[r % 4][c % 4] + 0.5) / 16
                    if v > threshold {
                        let bucket = min(3, max(0, Int(v / 0.85 * 4)))
                        buckets[bucket].addRect(CGRect(x: CGFloat(c) * cell, y: CGFloat(r) * cell, width: dot, height: dot))
                    }
                }
            }
            for (index, path) in buckets.enumerated() {
                let v = (Double(index) + 0.5) / 4 * 0.85
                context.fill(path, with: .color(color.opacity(0.55 + 0.45 * v)))
            }
            // Fade into the card body.
            context.fill(full, with: .linearGradient(
                Gradient(colors: [PennyColor.cardBackground.opacity(0), PennyColor.cardBackground]),
                startPoint: CGPoint(x: 0, y: size.height * 0.5),
                endPoint: CGPoint(x: 0, y: size.height)
            ))
        }
        .accessibilityHidden(true)
    }
}
