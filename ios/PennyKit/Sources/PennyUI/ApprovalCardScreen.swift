import PennyCore
import SwiftUI

public enum CardPresentation: Sendable {
    /// Live bubble in the Messages transcript: the card alone.
    case transcript
    /// Full-height sheet: the card, what exactly gets signed, and a decline option.
    case expanded
}

/// Hosts an approval card in either presentation. Used by the Messages extension.
public struct ApprovalCardScreen: View {
    @ObservedObject var model: ApprovalCardModel
    let presentation: CardPresentation
    let onRequestExpanded: () -> Void

    public init(model: ApprovalCardModel, presentation: CardPresentation, onRequestExpanded: @escaping () -> Void = {}) {
        self.model = model
        self.presentation = presentation
        self.onRequestExpanded = onRequestExpanded
    }

    public var body: some View {
        switch presentation {
        case .transcript:
            card
        case .expanded:
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    card
                    if model.phase == .ask {
                        Button { Task { await model.decline() } } label: {
                            Text("Not now · nothing moves")
                                .font(.geist(12.5, medium: true))
                                .foregroundStyle(PennyColor.meta)
                                .frame(maxWidth: .infinity)
                                .frame(height: 38)
                                .overlay(Capsule().strokeBorder(Color.white.opacity(0.18), lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                    if let note = model.note {
                        Text(note)
                            .font(.geist(12))
                            .foregroundStyle(PennyColor.meta)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if !model.signingPreview.isEmpty {
                        SigningPreview(summaries: model.signingPreview, approval: model.ticket?.detail)
                    }
                }
                .frame(maxWidth: 380)
                .padding(20)
                .frame(maxWidth: .infinity)
            }
            .background(Color.black.ignoresSafeArea())
        }
    }

    private var card: some View {
        PennyCardView(content: model.content ?? Self.placeholder, phase: model.phase) { action in
            if action == .details {
                if presentation == .transcript { onRequestExpanded() }
            } else {
                model.handle(action)
            }
        }
    }

    static let placeholder = CardContent(
        kind: .plain, trailing: "", meta: "Penny", headline: "—", rows: [], buttons: [], foot: nil, crew: .penny, tag: "● PENNY"
    )
}

/// "What you're signing": decoded from the actions the device will sign, so a spoofed title can't hide anything.
struct SigningPreview: View {
    let summaries: [ActionSummary]
    let approval: Approval?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("WHAT YOU'RE SIGNING")
                .font(.geistMono(10))
                .tracking(0.9)
                .foregroundStyle(PennyColor.meta)
            ForEach(summaries) { summary in
                VStack(alignment: .leading, spacing: 6) {
                    Text(summary.title).font(.geist(13, medium: true)).foregroundStyle(PennyColor.text)
                    ForEach(summary.lines, id: \.self) { line in
                        Text(line)
                            .font(.geistMono(11))
                            .foregroundStyle(PennyColor.meta)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(PennyColor.cardBackground))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(PennyColor.border, lineWidth: 1))
            }
            if let approval {
                Text("Good until \(approval.expiresAt.formatted(date: .omitted, time: .shortened)) · signed on this iPhone only")
                    .font(.geistMono(10))
                    .foregroundStyle(PennyColor.meta.opacity(0.7))
            }
        }
    }
}
