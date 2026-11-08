import PennyCore
import SwiftUI

/// One card, shared anatomy: art, tag, what it is, the number, one or two facts, one action.
/// design/card/family.html (types) + card.html (ask → Face ID → approved → done).
public struct PennyCardView: View {
    let content: CardContent
    let phase: CardPhase
    let onAction: (CardActionID) -> Void

    public init(content: CardContent, phase: CardPhase = .ask, onAction: @escaping (CardActionID) -> Void = { _ in }) {
        self.content = content
        self.phase = phase
        self.onAction = onAction
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topLeading) {
                DitherArt(color: artColor, mood: phase.mood, center: content.kind.artCenter, phase: content.kind.artPhase)
                    .frame(height: 88)
                CrewChip(content.crew).padding(10)
            }
            VStack(alignment: .leading, spacing: 0) {
                tagRow
                Text(content.meta)
                    .font(.geist(11.5))
                    .foregroundStyle(PennyColor.meta)
                    .lineLimit(1)
                    .padding(.top, 12)
                Text(content.headline)
                    .font(.geist(content.headlineIsText ? 21 : 30))
                    .tracking(content.headlineIsText ? -0.6 : -1.2)
                    .foregroundStyle(PennyColor.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .padding(.top, 2)
                phaseBody
                if let foot = footText {
                    Button { onAction(isDone ? .openReceipt : .details) } label: {
                        Text(foot)
                            .font(.geist(11))
                            .foregroundStyle(PennyColor.meta)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 10)
                }
            }
            .padding(.top, 12)
            .padding(.horizontal, 14)
            .padding(.bottom, 12)
        }
        .background(PennyColor.cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(PennyColor.border, lineWidth: 1))
        .animation(.easeOut(duration: 0.18), value: phase)
    }

    private var isDone: Bool {
        if case .done = phase { return true }
        return false
    }

    // MARK: Tag row

    private var tagRow: some View {
        HStack {
            Tag(text: tagText, palette: tagPalette)
            Spacer(minLength: 8)
            Text(trailingText)
                .font(.geistMono(11))
                .foregroundStyle(PennyColor.meta)
                .monospacedDigit()
        }
    }

    private var tagText: String {
        switch phase {
        case .done: return "● SETTLED"
        case .expired: return "○ EXPIRED"
        case .declined: return "× DECLINED"
        case .failed: return "! FAILED"
        case .blocked: return "■ BLOCKED"
        case .closed: return "○ DONE"
        default: return content.tag
        }
    }

    private var tagPalette: CardPalette {
        switch phase {
        case .done: return .mint
        case .expired, .declined, .closed: return .muted
        case .failed, .blocked: return .red
        default: return content.kind.palette
        }
    }

    private var trailingText: String {
        if case let .done(_, at) = phase {
            return at.formatted(date: .omitted, time: .shortened)
        }
        switch phase {
        case .expired: return "0:00"
        case .declined, .failed, .blocked, .closed: return ""
        default: return content.trailing
        }
    }

    private var artColor: Color {
        switch phase {
        case .approved: return CardPalette.mint.art
        case .done: return CardPalette.green.art
        case .expired, .declined, .unavailable, .closed: return CardPalette.muted.art
        case .failed, .blocked: return CardPalette.red.art
        default: return content.kind.palette.art
        }
    }

    private var footText: String? {
        switch phase {
        case .done: return content.foot // "View receipt ›" only when there is a receipt
        case .loading, .unavailable, .closed: return nil
        default: return content.foot
        }
    }

    // MARK: Body per phase

    @ViewBuilder
    private var phaseBody: some View {
        switch phase {
        case .loading:
            HStack(spacing: 8) {
                ProgressView().tint(PennyColor.meta)
                Text("Loading").font(.geist(11.5)).foregroundStyle(PennyColor.meta)
            }
            .padding(.top, 14)
        case .ask:
            rows
            buttons(enabled: true)
        case .approving:
            rows
            Pill(title: CardState.approving.pillTitle ?? "Approving…", faceID: true, fill: PennyColor.pillDim, text: PennyColor.text)
                .padding(.top, 12)
        case let .approved(steps):
            Pill(title: "✓ Approved", faceID: false, fill: PennyColor.okBackground, text: PennyColor.okText)
                .padding(.top, 12)
            StepsList(steps: steps).padding(.top, 12)
        case let .done(steps, _):
            Pill(title: "✓ \(CardState.sent.pillTitle ?? "Sent")", faceID: false, fill: PennyColor.okBackground, text: PennyColor.okText)
                .padding(.top, 12)
            if !steps.isEmpty { StepsList(steps: steps).padding(.top, 12) }
        case .expired:
            rows.opacity(0.5)
            Button { onAction(.renew) } label: {
                Pill(title: CardState.expired.pillTitle ?? "Get a new card", faceID: false, fill: PennyColor.pillDim, text: PennyColor.text)
            }
            .buttonStyle(PressStyle())
            .padding(.top, 12)
        case .info:
            rows
            buttons(enabled: true)
        case let .closed(message):
            rows.opacity(0.5)
            Text(message).font(.geist(11.5)).foregroundStyle(PennyColor.meta).padding(.top, 12)
        case let .blocked(message):
            Text(message)
                .font(.geist(12))
                .foregroundStyle(PennyColor.text)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)
            Button { onAction(.notMe) } label: {
                Pill(title: CardState.blocked.pillTitle ?? "Not me", faceID: false, fill: PennyColor.ink.opacity(0.6),
                     text: PennyColor.text, stroke: Color.white.opacity(0.3))
            }
            .buttonStyle(PressStyle())
            .padding(.top, 12)
        case .declined:
            rows.opacity(0.5)
            Pill(title: "Declined · nothing moved", faceID: false, fill: PennyColor.pillDim, text: PennyColor.meta)
                .padding(.top, 12)
        case let .failed(message, steps):
            if !steps.isEmpty { StepsList(steps: steps).padding(.top, 12) }
            Text(message)
                .font(.geist(11.5))
                .foregroundStyle(PennyColor.errorText)
                .padding(.top, 12)
            buttons(enabled: true)
        case let .unavailable(message):
            Text(message)
                .font(.geist(11.5))
                .foregroundStyle(PennyColor.meta)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)
        }
    }

    @ViewBuilder
    private var rows: some View {
        let options = content.rows.contains { if case .option = $0 { return true } else { return false } }
        if options {
            VStack(spacing: 6) {
                ForEach(Array(content.rows.enumerated()), id: \.offset) { index, row in
                    if case let .option(title, detail, selected) = row {
                        OptionRow(title: title, detail: detail, selected: selected) { onAction(.pickOption(index)) }
                    }
                }
            }
            .padding(.top, 6)
        } else if !content.rows.isEmpty {
            VStack(spacing: 0) {
                Hairline(color: PennyColor.hairline)
                ForEach(Array(content.rows.enumerated()), id: \.offset) { _, row in
                    RowView(row: row, palette: content.kind.palette)
                    Hairline(color: PennyColor.hairlineSoft)
                }
            }
            .padding(.top, 10)
        }
    }

    @ViewBuilder
    private func buttons(enabled: Bool) -> some View {
        if !content.buttons.isEmpty {
            HStack(spacing: 8) {
                ForEach(content.buttons, id: \.self) { button in
                    Button { onAction(button.action) } label: {
                        if button.style == .faceID {
                            Pill(title: button.title, faceID: true, fill: .white, text: PennyColor.ink)
                        } else {
                            Pill(title: button.title, faceID: false, fill: PennyColor.ink.opacity(0.6), text: PennyColor.text, stroke: Color.white.opacity(0.3))
                        }
                    }
                    .buttonStyle(PressStyle())
                    .disabled(!enabled)
                }
            }
            .padding(.top, 12)
        }
    }
}

// MARK: - Pieces

struct Tag: View {
    let text: String
    let palette: CardPalette

    var body: some View {
        Text(text)
            .font(.geistMono(9.5))
            .tracking(0.8)
            .foregroundStyle(palette.tagText)
            .padding(.vertical, 5)
            .padding(.horizontal, 8)
            .background(Capsule().fill(palette.tagBackground))
            .lineLimit(1)
    }
}

/// 38pt pill. White with a Face ID glyph for money actions, outlined for everything else.
struct Pill: View {
    let title: String
    let faceID: Bool
    let fill: Color
    let text: Color
    var stroke: Color? = nil

    var body: some View {
        HStack(spacing: 8) {
            if faceID {
                Image(systemName: "faceid").font(.system(size: 14, weight: .regular))
            }
            Text(title).font(.geist(12.5, medium: true)).lineLimit(1).minimumScaleFactor(0.8)
        }
        .foregroundStyle(text)
        .frame(maxWidth: .infinity)
        .frame(height: 38)
        .background(Capsule().fill(fill))
        .overlay {
            if let stroke { Capsule().strokeBorder(stroke, lineWidth: 1) }
        }
        .contentShape(Capsule())
    }
}

struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.8 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
    }
}

struct Hairline: View {
    let color: Color
    var body: some View { Rectangle().fill(color).frame(height: 1) }
}

struct RowView: View {
    let row: CardRow
    let palette: CardPalette

    var body: some View {
        switch row {
        case let .fact(label, value):
            HStack(spacing: 8) {
                Text(label).foregroundStyle(PennyColor.meta)
                Spacer(minLength: 8)
                Text(value).foregroundStyle(PennyColor.text).multilineTextAlignment(.trailing)
            }
            .font(.geist(11))
            .padding(.vertical, 7)
        case let .meter(label, value, fraction):
            VStack(spacing: 6) {
                HStack(spacing: 8) {
                    Text(label).foregroundStyle(PennyColor.meta)
                    Spacer(minLength: 8)
                    Text(value).foregroundStyle(PennyColor.text)
                }
                .font(.geist(11))
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(PennyColor.track)
                        Capsule().fill(palette.art).frame(width: geo.size.width * fraction)
                    }
                }
                .frame(height: 3)
            }
            .padding(.vertical, 7)
        case let .person(name, color, value, pill):
            HStack(spacing: 8) {
                Circle().fill(color).frame(width: 18, height: 18)
                Text(name).foregroundStyle(PennyColor.text)
                Spacer(minLength: 8)
                if let value { Text(value).foregroundStyle(PennyColor.text) }
                if let pill {
                    Text(pill)
                        .font(.geistMono(9))
                        .tracking(0.6)
                        .foregroundStyle(palette.tagText)
                        .padding(.vertical, 3)
                        .padding(.horizontal, 6)
                        .background(Capsule().fill(palette.tagBackground))
                }
            }
            .font(.geist(11))
            .padding(.vertical, 7)
        case .option:
            EmptyView()
        }
    }
}

struct OptionRow: View {
    let title: String
    let detail: String
    let selected: Bool
    let tap: () -> Void

    var body: some View {
        Button(action: tap) {
            HStack {
                Text(title).font(.geist(12)).foregroundStyle(PennyColor.text)
                Spacer(minLength: 8)
                Text(detail).font(.geistMono(11)).foregroundStyle(PennyColor.meta)
            }
            .padding(.vertical, 9)
            .padding(.horizontal, 10)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(selected ? PennyColor.optionSelected : Color.clear))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(selected ? CardPalette.blue.art : PennyColor.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
    }
}

struct StepsList: View {
    let steps: [StatusStep]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                HStack(spacing: 8) {
                    StepDot(state: step.state)
                    Text(step.label)
                        .font(.geist(11.5))
                        .foregroundStyle(step.state == .active ? PennyColor.text : PennyColor.meta)
                        .lineLimit(2)
                }
                .padding(.vertical, 4)
                .transition(.opacity)
            }
        }
    }
}

struct StepDot: View {
    let state: StatusStep.State

    var body: some View {
        ZStack {
            Circle().fill(fill)
            switch state {
            case .done:
                Image(systemName: "checkmark").font(.system(size: 7, weight: .bold)).foregroundStyle(.white)
            case .active:
                Text("…").font(.system(size: 8, weight: .bold)).foregroundStyle(.white).offset(y: -2)
            case .failed:
                Image(systemName: "xmark").font(.system(size: 7, weight: .bold)).foregroundStyle(.white)
            case .todo:
                EmptyView()
            }
        }
        .frame(width: 14, height: 14)
    }

    private var fill: Color {
        switch state {
        case .done: return PennyColor.stepDone
        case .active: return PennyColor.stepActive
        case .failed: return CardPalette.red.art
        case .todo: return PennyColor.track
        }
    }
}

#if DEBUG
#Preview("Family") {
    ScrollView {
        VStack(spacing: 20) {
            ForEach(CardSamples.all, id: \.kind) { card in
                PennyCardView(content: card)
            }
        }
        .padding(20)
    }
    .background(Color.white)
}

#Preview("Moments") {
    ScrollView {
        VStack(spacing: 20) {
            PennyCardView(content: CardSamples.invest, phase: .ask)
            PennyCardView(content: CardSamples.invest, phase: .approving)
            PennyCardView(content: CardSamples.invest, phase: .approved(steps: CardSamples.approvedSteps))
            PennyCardView(content: CardSamples.invest, phase: .done(steps: CardSamples.doneSteps, at: Date()))
            PennyCardView(content: CardSamples.invest, phase: .expired)
        }
        .frame(width: 280)
        .padding(20)
    }
}
#endif
