import Foundation

// Live cards (docs/DESIGN.md section 4). One URL for both paths: https://<engine>/a/<cardToken>.
// The extension reads the token from the selected message, fetches the card and, for
// approval cards, the action, approval hash, single-use challenge and expiry.
// Mirrors `Card` and `ApprovalByTokenResponse` in packages/shared/src/cards.ts.

/// The 256-bit card token from a card URL. Only the token travels; the host is ignored
/// on purpose (requests always go to the configured engine).
public struct CardToken: Equatable, Hashable, Sendable {
    public let value: String

    public init?(_ value: String) {
        guard value.utf8.count == 43, Validate.base64URL(value), !value.hasPrefix("apr_") else { return nil }
        self.value = value
    }

    /// `https://<engine>/a/<token>`, with or without a `?v=…` suffix (fresh link cards).
    public init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let segments = components.path.split(separator: "/").map(String.init)
        guard let idx = segments.lastIndex(of: "a"), idx + 1 < segments.count else { return nil }
        self.init(segments[idx + 1])
    }
}

/// Card states. Approval cards: ready -> approving -> sent | blocked | expired (+ declined, failed).
/// Info cards: done, or undone after Undo.
public enum CardState: String, Sendable, CaseIterable {
    case ready, approving, sent, done, blocked, expired, declined, failed, undone

    /// The main pill for an approval card in this state, in plain words.
    public var pillTitle: String? {
        switch self {
        case .ready: return "Approve with Face ID"
        case .approving: return "Approving…"
        case .sent: return "Sent"
        case .expired: return "Get a new card"
        case .blocked: return "Not me"
        default: return nil
        }
    }

    /// The second button on a ready approval card.
    public var secondaryTitle: String? { self == .ready ? "Not now" : nil }

    /// One plain line under the card when nothing more can happen.
    public var closingLine: String? {
        switch self {
        case .sent: return "Done. It went through."
        case .expired: return "This card ran out of time. Nothing moved."
        case .declined: return "You said no. Nothing moved."
        // only the server knows whether anything moved: PennyCard.statusLine says so when it can
        case .failed: return "It didn't go through."
        case .undone: return "Undone."
        default: return nil
        }
    }

    public var isFinal: Bool {
        switch self {
        case .sent, .done, .blocked, .expired, .declined, .failed, .undone: return true
        case .ready, .approving: return false
        }
    }
}

public struct CardLine: Equatable, Hashable, Sendable {
    public let label: String?
    public let value: String
    public init(label: String?, value: String) {
        self.label = label
        self.value = value
    }
}

public struct CardButtonSpec: Equatable, Hashable, Sendable {
    public let id: String
    public let label: String
    /// open, edit, undo, pick, send, approve, decline, renew, freeze (unknown -> open)
    public let action: String
    public let value: String?
}

/// Any card Penny sends. Unknown types and states never fail to parse: they render as
/// a plain card with title and lines.
public struct PennyCard: Equatable, Sendable {
    public let id: String
    public let agent: String
    public let isApproval: Bool
    public let type: String
    public let title: String
    public let amount: String?
    public let lines: [CardLine]
    public let buttons: [CardButtonSpec]
    public let state: CardState
    public let approvalId: String?
    public let expiresAt: Date?
    public let receiptURL: URL?
    /// What happened, as the server knows it ("couldn't confirm…"). Shown as is.
    public var statusLine: String? = nil

    public static func parse(_ json: JSONValue) throws -> PennyCard {
        guard let o = json.objectValue, let title = o["title"]?.stringValue, !title.isEmpty else {
            throw PennyError.invalidResponse("card")
        }
        let lines: [CardLine] = (o["lines"]?.arrayValue ?? []).prefix(8).compactMap { item in
            guard let value = item["value"]?.stringValue, !value.isEmpty else { return nil }
            return CardLine(label: item["label"]?.stringValue, value: String(value.prefix(120)))
        }
        let buttons: [CardButtonSpec] = (o["buttons"]?.arrayValue ?? []).prefix(3).compactMap { item in
            guard let id = item["id"]?.stringValue, let label = item["label"]?.stringValue else { return nil }
            return CardButtonSpec(id: id, label: String(label.prefix(32)), action: item["action"]?.stringValue ?? "open",
                                  value: item["value"]?.stringValue)
        }
        let receipt = o["receiptUrl"]?.stringValue.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil }
        var card = PennyCard(
            id: o["id"]?.stringValue ?? "",
            agent: o["agent"]?.stringValue ?? "penny",
            isApproval: o["kind"]?.stringValue == "approval",
            type: o["type"]?.stringValue ?? "plain",
            title: String(title.prefix(80)),
            amount: o["amount"]?.stringValue,
            lines: lines,
            buttons: buttons,
            state: o["state"]?.stringValue.flatMap(CardState.init(rawValue:)) ?? .done,
            approvalId: o["approvalId"]?.stringValue,
            expiresAt: o["expiresAt"]?.stringValue.flatMap(Validate.date),
            receiptURL: receipt
        )
        card.statusLine = o["statusLine"]?.stringValue.map { String($0.prefix(120)) }
        return card
    }
}

/// The four fields a person approves.
public struct ApprovalIntent: Equatable, Sendable {
    public let type: String
    public let to: String
    public let amount: String
    public let asset: String

    public var json: JSONValue {
        .object(["type": .string(type), "to": .string(to), "amount": .string(amount), "asset": .string(asset)])
    }

    /// Same mapping as approvalActionOf() in packages/shared/src/approval-hash.ts.
    public static func from(plan: JSONValue) -> ApprovalIntent? {
        func s(_ k: String) -> String? { plan[k]?.stringValue }
        switch s("kind") {
        case "send":
            guard let to = s("to"), let amount = s("amount"), let asset = s("asset") else { return nil }
            return ApprovalIntent(type: "send", to: to, amount: amount, asset: asset)
        case "invest":
            guard let to = s("portfolioId"), let amount = s("amountUsd") else { return nil }
            return ApprovalIntent(type: "invest", to: to, amount: amount, asset: "USDC")
        case "pay_bill":
            guard let to = s("payee"), let amount = s("amount"), let asset = s("asset") else { return nil }
            return ApprovalIntent(type: "pay_bill", to: to, amount: amount, asset: asset)
        case "errand":
            guard let to = s("taskId"), let amount = s("amount"), let asset = s("asset") else { return nil }
            return ApprovalIntent(type: "errand", to: to, amount: amount, asset: asset)
        case "split":
            guard let total = s("total") else { return nil }
            return ApprovalIntent(type: "split", to: "group", amount: total, asset: "USDC")
        case "create_bot":
            guard let slug = s("slug") else { return nil }
            return ApprovalIntent(type: "create_bot", to: slug, amount: plan["permissions"]?["dailyCap"]?.stringValue ?? "0", asset: "USDC")
        case "write":
            guard let toolkit = s("toolkit"), let slug = s("toolSlug") else { return nil }
            return ApprovalIntent(type: "write", to: "\(toolkit):\(slug)", amount: "0", asset: "none")
        default:
            return nil
        }
    }
}

/// approvalHash = base64url(sha256(JCS({ action, expiresAt, id, planHash }))) and the message the
/// key signs. Shared vector: packages/shared/test-vectors/09-approval-hash.json.
public enum ApprovalHash {
    public static func compute(id: String, action: ApprovalIntent, expiresAt: String, planHash: String) -> String {
        CanonicalJSON.sha256Base64URL(.object([
            "action": action.json,
            "expiresAt": .string(expiresAt),
            "id": .string(id),
            "planHash": .string(planHash),
        ]))
    }

    public static func message(hash: String, challenge: String) -> Data {
        Data("penny-approval:v2:\(hash):\(challenge)".utf8)
    }
}

/// What an approval card needs to be signed. The phone recomputes the hash itself from the
/// plan + actions it is about to sign; it never trusts the server's hash or wording.
public struct ApprovalTicket: Equatable, Sendable {
    public let id: String
    public let intent: ApprovalIntent
    public let approvalHash: String
    /// nil once used, expired or no longer pending.
    public let challenge: String?
    /// The exact ISO string the hash covers.
    public let expiresAtRaw: String
    public let expiresAt: Date
    public let status: ApprovalStatus
    public let detail: Approval

    public static func parse(_ json: JSONValue) throws -> ApprovalTicket {
        guard let o = json.objectValue,
              let id = o["id"]?.stringValue, Validate.approvalId(id),
              let hash = o["approvalHash"]?.stringValue,
              let expiresRaw = o["expiresAt"]?.stringValue, let expires = Validate.date(expiresRaw),
              let statusRaw = o["status"]?.stringValue, let status = ApprovalStatus(rawValue: statusRaw),
              let detailJSON = o["detail"]
        else { throw PennyError.invalidResponse("ticket") }
        let detail = try Approval.parse(detailJSON) // strict: recomputes planHash
        guard detail.id == id else { throw PennyError.invalidResponse("ticket id") }
        guard let intent = ApprovalIntent.from(plan: detail.plan) else { throw PennyError.invalidResponse("ticket plan") }
        if let sent = o["action"], sent != intent.json { throw PennyError.invalidResponse("ticket action") }
        let recomputed = ApprovalHash.compute(id: id, action: intent, expiresAt: expiresRaw, planHash: detail.planHash)
        guard recomputed == hash else { throw PennyError.invalidResponse("approvalHash mismatch") }
        let challenge = o["challenge"]?.stringValue
        if let challenge, !Validate.base64URL(challenge, length: 43) { throw PennyError.invalidResponse("challenge") }
        return ApprovalTicket(id: id, intent: intent, approvalHash: hash, challenge: challenge,
                              expiresAtRaw: expiresRaw, expiresAt: expires, status: status, detail: detail)
    }

    /// Face ID sheet text, e.g. "Approve sending 0.1 NEAR".
    public var faceIDReason: String {
        switch intent.type {
        case "send": return "Approve sending \(intent.amount) \(intent.asset)"
        case "invest": return "Approve buying $\(intent.amount) of \(intent.to)"
        case "pay_bill": return "Approve paying \(intent.to)"
        case "errand": return "Approve paying for this errand"
        case "write": return "Approve: \(detail.title)"
        case "create_bot": return "Approve your new bot"
        default: return "Approve with Face ID"
        }
    }
}

public struct CardByToken: Equatable, Sendable {
    public let card: PennyCard
    public let ticket: ApprovalTicket?
    /// Unfreeze cards only: the single-use challenge Face ID signs.
    public var unfreezeChallenge: String? = nil

    public static func parse(_ data: Data) throws -> CardByToken {
        let root = try JSONParser.parse(data)
        guard let cardJSON = root["card"] else { throw PennyError.invalidResponse("card") }
        let card = try PennyCard.parse(cardJSON)
        let ticket = try root["approval"].map(ApprovalTicket.parse)
        if let ticket, let linked = card.approvalId, linked != ticket.id { throw PennyError.invalidResponse("card link") }
        var out = CardByToken(card: card, ticket: ticket)
        if let ch = root["unfreeze"]?["challenge"]?.stringValue {
            guard Validate.base64URL(ch, length: 43) else { throw PennyError.invalidResponse("unfreeze challenge") }
            out.unfreezeChallenge = ch
        }
        return out
    }
}

/// The message the frozen device key signs to unfreeze (penny-unfreeze:v1:<cardId>:<challenge>).
public enum UnfreezeMessage {
    public static func message(cardId: String, challenge: String) -> Data {
        Data("penny-unfreeze:v1:\(cardId):\(challenge)".utf8)
    }
}

/// What the phone sends to POST /v1/approvals/:id/sign.
public struct ApprovalSignatures: Sendable {
    /// ed25519 over ApprovalHash.message(hash, challenge).
    public let signature: Data
    public let signedDelegateAction: SignedDelegateAction?
    public let planSignature: Data?
}

/// NEAR amounts for people: yocto (10^-24) base units to "0.1". Never shows the unit name
/// of the base units on a card.
public enum NearAmount {
    public static func display(yocto: String, maxDecimals: Int = 6) -> String {
        guard !yocto.isEmpty, yocto.allSatisfy(\.isNumber) else { return yocto }
        let digits = String(yocto.drop(while: { $0 == "0" }))
        if digits.isEmpty { return "0" }
        let padded = String(repeating: "0", count: max(0, 25 - digits.count)) + digits
        let whole = String(padded.dropLast(24)).drop(while: { $0 == "0" })
        var frac = String(padded.suffix(24).prefix(maxDecimals))
        while frac.hasSuffix("0") { frac.removeLast() }
        let w = whole.isEmpty ? "0" : String(whole)
        if w == "0" && frac.isEmpty { return "less than 0.\(String(repeating: "0", count: maxDecimals - 1))1" }
        return frac.isEmpty ? w : "\(w).\(frac)"
    }
}
