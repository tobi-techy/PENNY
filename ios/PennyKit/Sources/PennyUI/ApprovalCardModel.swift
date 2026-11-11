import Foundation
import PennyCore
import SwiftUI

/// The handful of engine calls one card makes. The app uses `EngineClient`; tests inject a
/// fake so the whole load → Face ID → sign → post path can run without a network.
public protocol ApprovalCardClient: Sendable {
    func card(_ token: CardToken) async throws -> CardByToken
    func freshPrice(_ token: CardToken) async throws
    func sign(_ link: CardLink, deviceId: String, signatures: ApprovalSignatures) async throws -> ApprovalStatus
    func decline(_ link: CardLink, reason: String?) async throws -> ApprovalStatus
    func unfreeze(_ token: CardToken, deviceId: String, signature: Data) async throws
    func press(_ token: CardToken, buttonId: String, confirm: Bool) async throws
    func renew(_ token: CardToken) async throws -> String?
    func status(_ link: CardLink) async throws -> ApprovalStatusResponse
}

/// Wraps the HTTP client and supplies one idempotency key per call.
public struct ApprovalCardClientAdapter: ApprovalCardClient {
    private let client: EngineClient

    public init(client: EngineClient) { self.client = client }

    public func card(_ token: CardToken) async throws -> CardByToken { try await client.card(token) }
    public func freshPrice(_ token: CardToken) async throws { try await client.freshPrice(token) }
    public func sign(_ link: CardLink, deviceId: String, signatures: ApprovalSignatures) async throws -> ApprovalStatus {
        try await client.sign(link, deviceId: deviceId, signatures: signatures, idempotencyKey: UUID().uuidString)
    }
    public func decline(_ link: CardLink, reason: String?) async throws -> ApprovalStatus {
        try await client.decline(link, reason: reason, idempotencyKey: UUID().uuidString)
    }
    public func unfreeze(_ token: CardToken, deviceId: String, signature: Data) async throws {
        try await client.unfreeze(token, deviceId: deviceId, signature: signature, idempotencyKey: UUID().uuidString)
    }
    public func press(_ token: CardToken, buttonId: String, confirm: Bool) async throws {
        try await client.press(token, buttonId: buttonId, confirm: confirm, idempotencyKey: UUID().uuidString)
    }
    public func renew(_ token: CardToken) async throws -> String? {
        try await client.renew(token, idempotencyKey: UUID().uuidString)
    }
    public func status(_ link: CardLink) async throws -> ApprovalStatusResponse {
        try await client.status(link)
    }
}

/// Drives one live card in the thread: load by card token → Ready → Face ID → sign → Approving
/// → Sent (with a receipt link) or Blocked. Info cards (reminder set, draft ready) show their
/// buttons; Undo / Edit need no Face ID, Send turns the card into an approval card first.
@MainActor
public final class ApprovalCardModel: ObservableObject {
    @Published public private(set) var card: PennyCard?
    @Published public private(set) var ticket: ApprovalTicket?
    @Published public private(set) var phase: CardPhase = .loading
    @Published public private(set) var now = Date()
    /// The decoded actions the device is about to sign (shown in details, not server prose).
    @Published public private(set) var signingPreview: [ActionSummary] = []
    /// Set after "Get a new card": the new one arrives in the thread.
    @Published public private(set) var note: String?
    /// Unfreeze cards: the challenge Face ID signs.
    private var unfreezeChallenge: String?
    /// "Not me" switches every key off: the screen asks first.
    @Published public private(set) var confirmingFreeze: String?
    private var askedForFreshPrice = false
    private static let refreshNote = "couldn't refresh this card. it will catch up in a moment."

    public let token: CardToken
    private let client: any ApprovalCardClient
    private let signer: MessageSigner
    private let expectedAccountId: String?
    private let deviceId: String?
    private var clock: Timer?
    private var pollTask: Task<Void, Never>?

    /// Face ID can't run in the transcript bubble; the host switches to the expanded presentation.
    public var onNeedsExpandedPresentation: (() -> Void)?
    /// Open a URL (receipt link) from the extension.
    public var onOpenURL: ((URL) -> Void)?

    public init(token: CardToken, client: any ApprovalCardClient, signer: MessageSigner, expectedAccountId: String?, deviceId: String?) {
        self.token = token
        self.client = client
        self.signer = signer
        self.expectedAccountId = expectedAccountId
        self.deviceId = deviceId
    }

    // No deinit: callers invoke stop() when the card leaves the screen (timer and poller hold self weakly).

    // MARK: Derived

    public var content: CardContent? {
        guard let card else { return nil }
        return CardContent(card: card, trailing: countdownText)
    }

    /// "1:30 left" until the approval expires.
    public var countdownText: String {
        guard let card, card.isApproval, card.state == .ready, let exp = card.expiresAt else { return "" }
        let remaining = max(0, Int(exp.timeIntervalSince(now).rounded(.down)))
        return String(format: "%d:%02d left", remaining / 60, remaining % 60)
    }

    var link: CardLink? {
        guard let ticket else { return nil }
        return CardLink(approvalId: ticket.id, cardToken: token.value)
    }

    // MARK: Lifecycle

    public func start() {
        startClock()
        Task { await load() }
    }

    public func stop() {
        clock?.invalidate()
        clock = nil
        pollTask?.cancel()
        pollTask = nil
    }

    private func startClock() {
        clock?.invalidate()
        clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func tick() {
        now = Date()
        if phase == .ask, let exp = card?.expiresAt, exp <= now { phase = .expired }
    }

    public func load() async {
        do {
            let fetched = try await client.card(token)
            card = fetched.card
            ticket = fetched.ticket
            unfreezeChallenge = fetched.unfreezeChallenge
            signingPreview = fetched.ticket.map { ActionSummary.describe($0.detail) } ?? []
            phase = CardPhase.from(card: fetched.card, now: Date())
            if note == Self.refreshNote { note = nil }
            if fetched.card.state == .approving { startPolling() }
            // an invest price lasts 90 s: opening the card gets a fresh one in place, once
            if fetched.card.type == "invest", fetched.card.state == .ready, !askedForFreshPrice {
                askedForFreshPrice = true
                if (try? await client.freshPrice(token)) != nil { await load() }
            }
        } catch let error as PennyError {
            // A card already on screen stays put through a refresh blip; only a first
            // load has nothing to show, so only then does it become unavailable.
            if card != nil {
                note = Self.refreshNote
            } else {
                phase = .unavailable(message: error.errorDescription ?? "Couldn't load this card.")
            }
        } catch {
            if card != nil {
                note = Self.refreshNote
            } else {
                phase = .unavailable(message: "Couldn't load this card.")
            }
        }
    }

    // MARK: Actions

    public func handle(_ action: CardActionID) {
        switch action {
        case .approve:
            Task { await approve() }
        case .decline:
            Task { await decline() }
        case .renew:
            Task { await renew() }
        case .notMe:
            confirmingFreeze = card?.buttons.first(where: { $0.action == "freeze" })?.id ?? "notme"
            onNeedsExpandedPresentation?()
        case let .button(id):
            if let b = card?.buttons.first(where: { $0.id == id }), b.action == "open", let v = b.value, let url = URL(string: v) {
                onOpenURL?(url)
            } else if card?.buttons.first(where: { $0.id == id })?.action == "unfreeze" {
                Task { await unfreeze() }
            } else {
                Task { await press(buttonId: id) }
            }
        case .openReceipt:
            if let url = card?.receiptURL { onOpenURL?(url) }
        default:
            break
        }
    }

    /// Face ID → sign approvalHash + challenge and the action → POST /sign. If Face ID fails or
    /// is cancelled the card stays Ready and nothing is sent.
    public func approve() async {
        guard let ticket, let link, let card, card.isApproval else { return }
        switch phase {
        case .ask, .failed: break
        default: return
        }
        guard let deviceId else {
            phase = .unavailable(message: PennyError.noDeviceKey.errorDescription ?? "Link this iPhone first.")
            return
        }
        phase = .approving
        do {
            let signatures = try await ApprovalSigning.signForApproval(ticket, with: signer, expectedAccountId: expectedAccountId)
            _ = try await client.sign(link, deviceId: deviceId, signatures: signatures)
            await load()
            if self.card?.state == .approving { startPolling() }
        } catch let error as PennyError {
            switch error {
            case .userCancelled:
                phase = .ask // stay on Ready; nothing was sent
            case .notInteractive:
                phase = .ask
                onNeedsExpandedPresentation?()
            case .expired:
                phase = .expired
            case .frozen:
                phase = .unavailable(message: error.errorDescription ?? "Penny is frozen. Text unfreeze to start again.")
            case .notPending, .http(status: 409), .http(status: 422):
                // the engine expired this card and sent a fresh one, or it was already handled
                await load()
                if phase == .expired { note = "That didn't check out. Penny sent you a new card." }
            default:
                // the signature may have reached the engine before the connection dropped
                phase = .failed(message: error.errorDescription ?? "Something went wrong. Check the card before trying again.", steps: [])
            }
        } catch {
            phase = .failed(message: "Something went wrong. Check the card before trying again.", steps: [])
        }
    }

    public func decline() async {
        guard let link, phase == .ask else { return }
        do {
            _ = try await client.decline(link, reason: nil)
            await load()
        } catch let error as PennyError {
            phase = .failed(message: error.errorDescription ?? "Couldn't say no just now.", steps: [])
        } catch {
            phase = .failed(message: "Couldn't say no just now.", steps: [])
        }
    }

    /// Unfreeze: Face ID unlocks the key the freeze switched off and signs this card's
    /// single-use challenge. A text alone never unfreezes Penny.
    public func unfreeze() async {
        guard let card, let challenge = unfreezeChallenge, let deviceId else { return }
        do {
            let message = UnfreezeMessage.message(cardId: card.id, challenge: challenge)
            let signature = try await signer.sign(message, reason: "Unfreeze Penny")
            try await client.unfreeze(token, deviceId: deviceId, signature: signature)
            await load()
        } catch PennyError.userCancelled {
            note = "Face ID was cancelled. Penny is still frozen."
        } catch PennyError.notInteractive {
            onNeedsExpandedPresentation?()
        } catch {
            note = "That didn't check out. Penny is still frozen. Text unfreeze for a new card."
            await load()
        }
    }

    /// "Yes, freeze everything" after Not me.
    public func confirmFreeze() async {
        guard let id = confirmingFreeze else { return }
        confirmingFreeze = nil
        do {
            try await client.press(token, buttonId: id, confirm: true)
            note = "Penny is frozen. Every key is off. Text unfreeze when you want it back."
            await load()
        } catch {
            note = "That didn't work. Try again."
        }
    }

    public func cancelFreeze() { confirmingFreeze = nil }

    /// "Get a new card": the engine checks Guard again and sends a fresh card to the thread.
    public func renew() async {
        do {
            // only say a card is coming when one was actually made
            if try await client.renew(token) != nil {
                note = "A new card is on its way."
            } else {
                note = "Penny couldn't make a new card. Ask Penny again."
            }
        } catch let error as PennyError {
            note = error.errorDescription
        } catch {
            note = "Couldn't get a new card. Ask Penny again."
        }
    }

    /// Info card buttons (Undo, Edit, Send, Not me). No Face ID; Send only turns the card
    /// into an approval card, the Face ID happens on that card.
    public func press(buttonId: String) async {
        do {
            try await client.press(token, buttonId: buttonId, confirm: false)
            await load()
        } catch let error as PennyError {
            note = error.errorDescription
        } catch {
            note = "That didn't work. Try again."
        }
    }

    // MARK: Status

    private func startPolling() {
        guard let link else { return }
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            var delay: UInt64 = 1_200_000_000
            for _ in 0..<120 { // ~3-4 minutes max
                try? await Task.sleep(nanoseconds: delay)
                guard !Task.isCancelled, let self else { return }
                if let response = try? await self.client.status(link), response.status.isTerminal {
                    await self.load()
                    return
                }
                delay = min(delay + 300_000_000, 3_000_000_000)
            }
        }
    }
}

/// Plain-language reading of exactly what will be signed, decoded from the approval's actions.
public struct ActionSummary: Identifiable, Hashable, Sendable {
    public let id: Int
    public let title: String
    public let lines: [String]

    public static func describe(_ approval: Approval) -> [ActionSummary] {
        // A write (or new bot) carries no NEAR actions: the signature seals the plan, so show
        // every argument in full, never just what fits on the card.
        if approval.kind.isPlanSigned {
            let args = approval.plan["arguments"]?.objectValue ?? [:]
            var lines = ["App: \(approval.plan["toolkit"]?.stringValue ?? "Penny")"]
            for key in args.keys.sorted() {
                let raw = args[key].map { $0.stringValue ?? CanonicalJSON.string($0) } ?? ""
                lines.append("\(key): \(PlainText.safe(raw))")
            }
            return [ActionSummary(id: 0, title: approval.title, lines: lines)]
        }
        return approval.actions.enumerated().map { index, action in
            switch action {
            case let .functionCall(methodName, args, _, deposit):
                var lines = ["App: \(approval.receiverId)", "From: \(approval.signerId)"]
                for key in args.keys.sorted() {
                    let value = args[key].map { $0.stringValue ?? CanonicalJSON.string($0) } ?? ""
                    lines.append("\(key): \(value.count > 80 ? String(value.prefix(77)) + "…" : value)")
                }
                if deposit != "0" { lines.append("Also sends: \(NearAmount.display(yocto: deposit)) NEAR") }
                return ActionSummary(id: index, title: "Run \(methodName)", lines: lines)
            case let .transfer(deposit):
                return ActionSummary(id: index, title: "Send NEAR", lines: [
                    "To: \(approval.receiverId)", "From: \(approval.signerId)", "Amount: \(NearAmount.display(yocto: deposit)) NEAR",
                ])
            }
        }
    }
}

/// Strips control and direction characters that could hide or reorder text.
enum PlainText {
    static func safe(_ s: String) -> String {
        String(String.UnicodeScalarView(s.unicodeScalars.map { scalar in
            let v = scalar.value
            let hidden = (v < 0x20 && v != 0x0A) || (0x7F...0x9F).contains(v) || (0x200B...0x200F).contains(v)
                || (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v)
            return hidden ? " " : scalar
        }))
    }
}
