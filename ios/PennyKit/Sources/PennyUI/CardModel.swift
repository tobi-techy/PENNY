import Foundation
import PennyCore
import SwiftUI

/// The eight cards in design/card/family.html. Same anatomy; colour + crew mark say who's asking.
public enum CardKind: String, CaseIterable, Sendable {
    case invest, send, bill, split, errand, guardBlock, pick, weekly

    public var palette: CardPalette {
        switch self {
        case .invest, .pick: return .blue
        case .send: return .green
        case .bill: return .orange
        case .split: return .purple
        case .errand: return .pink
        case .guardBlock: return .red
        case .weekly: return .mint
        }
    }

    public var crew: Crew {
        switch self {
        case .invest, .pick: return .invest
        case .send, .split, .errand: return .penny
        case .bill: return .mail
        case .guardBlock: return .guardian
        case .weekly: return .finance
        }
    }

    public var tag: String {
        switch self {
        case .invest: return "↗ INVEST"
        case .send: return "→ SEND"
        case .bill: return "✉ BILL"
        case .split: return "⇄ SPLIT"
        case .errand: return "✦ ERRAND"
        case .guardBlock: return "■ BLOCKED"
        case .pick: return "◇ PICK ONE"
        case .weekly: return "● YOUR WEEK"
        }
    }

    /// Where the art's peak sits, so neighbouring cards don't look stamped (family.html: 0.35 + i*0.17 % 0.45).
    var artCenter: Double { 0.35 + (Double(CardKind.allCases.firstIndex(of: self) ?? 0) * 0.17).truncatingRemainder(dividingBy: 0.45) }
    var artPhase: Double { Double(CardKind.allCases.firstIndex(of: self) ?? 0) * 1.3 }

    init(_ kind: ApprovalKind) {
        switch kind {
        case .invest: self = .invest
        case .send: self = .send
        case .payBill: self = .bill
        case .errand: self = .errand
        }
    }
}

public enum CardRow: Hashable, Sendable {
    case fact(label: String, value: String)
    /// A fact with a thin progress bar under it ("$50 of $100 left").
    case meter(label: String, value: String, fraction: Double)
    case person(name: String, color: Color, value: String?, pill: String?)
    case option(title: String, detail: String, selected: Bool)
}

public enum CardActionID: Hashable, Sendable {
    case approve, decline, notMe, allowOnce, nudge, details, seeWeek
    case pickOption(Int)
}

public struct CardButton: Hashable, Sendable {
    public enum Style: Sendable { case faceID, outline }
    public let title: String
    public let style: Style
    public let action: CardActionID

    public init(_ title: String, style: Style, action: CardActionID) {
        self.title = title
        self.style = style
        self.action = action
    }
}

public struct CardContent: Equatable, Sendable {
    public var kind: CardKind
    public var crew: Crew
    public var tag: String
    public var trailing: String
    public var meta: String
    public var headline: String
    /// Pick cards lead with words ("Three that fit you") instead of a number.
    public var headlineIsText: Bool
    public var rows: [CardRow]
    public var buttons: [CardButton]
    public var foot: String?

    public init(kind: CardKind, trailing: String, meta: String, headline: String, headlineIsText: Bool = false,
                rows: [CardRow], buttons: [CardButton], foot: String?, crew: Crew? = nil, tag: String? = nil) {
        self.kind = kind
        self.crew = crew ?? kind.crew
        self.tag = tag ?? kind.tag
        self.trailing = trailing
        self.meta = meta
        self.headline = headline
        self.headlineIsText = headlineIsText
        self.rows = rows
        self.buttons = buttons
        self.foot = foot
    }
}

/// Where the card is in its life. Drives the body, the tag and the art's mood.
public enum CardPhase: Equatable, Sendable {
    case loading
    case ask
    case approving
    case approved(steps: [StatusStep])
    case done(steps: [StatusStep], at: Date)
    case expired
    case declined
    case failed(message: String, steps: [StatusStep])
    case unavailable(message: String)

    var mood: ArtMood {
        switch self {
        case .loading, .approving, .approved: return .working
        case .ask: return .ask
        case .done: return .calm
        case .expired, .declined, .unavailable: return .quiet
        case .failed: return .alarm
        }
    }
}

// MARK: - Approval → card

extension CardContent {
    /// Builds the card for an engine Approval. `trailing` is usually the quote countdown ("1:55").
    public init(approval: Approval, trailing: String) {
        let kind = CardKind(approval.kind)
        let verb: String
        let foot: String
        switch kind {
        case .send: verb = "Send with Face ID"; foot = "View details ›"
        case .bill: verb = "Pay with Face ID"; foot = "View details ›"
        case .errand: verb = "Hire with Face ID"; foot = "View details ›"
        default: verb = "Approve with Face ID"; foot = "View details ›"
        }
        self.init(
            kind: kind,
            trailing: trailing,
            meta: approval.title,
            headline: approval.amountDisplay,
            rows: approval.facts.prefix(3).map(CardRow.init(fact:)),
            buttons: [CardButton(verb, style: .faceID, action: .approve)],
            foot: foot
        )
    }
}

extension CardRow {
    /// "X of Y" values get a meter (fraction = X / Y), everything else is a plain fact.
    init(fact: Fact) {
        if let fraction = CardRow.fraction(fact.value) {
            self = .meter(label: fact.label, value: fact.value, fraction: fraction)
        } else {
            self = .fact(label: fact.label, value: fact.value)
        }
    }

    static func fraction(_ value: String) -> Double? {
        let parts = value.components(separatedBy: " of ")
        guard parts.count == 2 else { return nil }
        func number(_ s: String) -> Double? {
            let token = s.split(separator: " ").first.map(String.init) ?? s
            let cleaned = token.filter { $0.isNumber || $0 == "." }
            return Double(cleaned)
        }
        guard let a = number(parts[0]), let b = number(parts[1]), b > 0 else { return nil }
        return min(1, max(0, a / b))
    }
}

// MARK: - Samples (family.html), used by previews and the host app's card gallery

public enum CardSamples {
    public static let invest = CardContent(
        kind: .invest, trailing: "1:55", meta: "Swap · USDC → ETH Momentum", headline: "$50.00",
        rows: [.fact(label: "Fee", value: "$0.12"), .meter(label: "Today's limit", value: "$50 of $100 left", fraction: 0.5)],
        buttons: [CardButton("Approve with Face ID", style: .faceID, action: .approve)], foot: "View details ›")

    public static let send = CardContent(
        kind: .send, trailing: "instant", meta: "To Ada · ada.near", headline: "$20.00",
        rows: [.fact(label: "Note", value: "suya on friday"), .fact(label: "Fee", value: "None")],
        buttons: [CardButton("Send with Face ID", style: .faceID, action: .approve)], foot: "Change amount ›")

    public static let bill = CardContent(
        kind: .bill, trailing: "due Fri", meta: "DStv Premium · found in Gmail", headline: "$18.40",
        rows: [.fact(label: "Same as last month", value: "Yes"), .meter(label: "Bills budget", value: "$42 of $80 left", fraction: 0.52)],
        buttons: [CardButton("Pay with Face ID", style: .faceID, action: .approve)], foot: "See the email ›")

    public static let split = CardContent(
        kind: .split, trailing: "3 people", meta: "Dinner at Nok", headline: "$64.00",
        rows: [
            .person(name: "You", color: Crew.penny.tile, value: "$21.34 paid", pill: nil),
            .person(name: "Ada", color: Crew.invest.tile, value: "$21.33 paid", pill: nil),
            .person(name: "Femi", color: Crew.guardian.tile, value: nil, pill: "WAITING"),
        ],
        buttons: [CardButton("Nudge Femi", style: .outline, action: .nudge)], foot: nil)

    public static let errand = CardContent(
        kind: .errand, trailing: "3 bids", meta: "Car wash · Sat 10 AM, Lekki", headline: "$12.00",
        rows: [.fact(label: "Best bid", value: "SparkleCo · 4.9"), .fact(label: "Paid when", value: "Job is done")],
        buttons: [CardButton("Hire with Face ID", style: .faceID, action: .approve)], foot: "See all bids ›")

    public static let guardBlock = CardContent(
        kind: .guardBlock, trailing: "just now", meta: "Send · to new-wallet.near", headline: "$400.00",
        rows: [.fact(label: "Why", value: "Over your $100 day"), .fact(label: "Also", value: "First time to this address")],
        buttons: [CardButton("Not me", style: .outline, action: .notMe), CardButton("Allow once", style: .faceID, action: .allowOnce)],
        foot: nil)

    public static let pick = CardContent(
        kind: .pick, trailing: "$50", meta: "Where should your $50 go?", headline: "Three that fit you", headlineIsText: true,
        rows: [
            .option(title: "Calm · ETH Momentum", detail: "+6.2% 30d", selected: true),
            .option(title: "Balanced · Majors", detail: "+9.8% 30d", selected: false),
            .option(title: "Bold · SOL Memes", detail: "+31% 30d", selected: false),
        ],
        buttons: [], foot: "Why these? ›")

    public static let weekly = CardContent(
        kind: .weekly, trailing: "Nov 2 to 8", meta: "Portfolio up this week", headline: "+$3.12",
        rows: [
            .meter(label: "Spent", value: "$142 of $200", fraction: 0.71),
            .fact(label: "Invested", value: "$50"),
            .fact(label: "Late fees dodged", value: "1"),
        ],
        buttons: [CardButton("See the full week", style: .outline, action: .seeWeek)], foot: nil)

    public static let all: [CardContent] = [invest, send, bill, split, errand, guardBlock, pick, weekly]

    public static let approvedSteps: [StatusStep] = [
        StatusStep(label: "Quote locked", state: .done),
        StatusStep(label: "Guard: within your $100 day", state: .done),
        StatusStep(label: "Swapping on NEAR Intents", state: .active),
    ]

    public static let doneSteps: [StatusStep] = [
        StatusStep(label: "Swapped 50 USDC", state: .done),
        StatusStep(label: "Deposited 0.0148 ETH", state: .done),
        StatusStep(label: "Fee $0.12", state: .done),
    ]
}
