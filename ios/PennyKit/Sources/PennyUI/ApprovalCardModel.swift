import Foundation
import PennyCore
import SwiftUI

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

    public let token: CardToken
    private let client: EngineClient
    private let signer: MessageSigner
    private let expectedAccountId: String?
    private let deviceId: String?
    private var clock: Timer?
    private var pollTask: Task<Void, Never>?

    /// Face ID can't run in the transcript bubble; the host switches to the expanded presentation.
    public var onNeedsExpandedPresentation: (() -> Void)?
    /// Open a URL (receipt link) from the extension.
    public var onOpenURL: ((URL) -> Void)?

    public init(token: CardToken, client: EngineClient, signer: MessageSigner, expectedAccountId: String?, deviceId: String?) {
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
            signingPreview = fetched.ticket.map { ActionSummary.describe($0.detail) } ?? []
            phase = CardPhase.from(card: fetched.card, now: Date())
            if fetched.card.state == .approving { startPolling() }
        } catch let error as PennyError {
            phase = .unavailable(message: error.errorDescription ?? "Couldn't load this card.")
        } catch {
            phase = .unavailable(message: "Couldn't load this card.")
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
            Task { await press(buttonId: card?.buttons.first(where: { $0.action == "freeze" })?.id ?? "notme") }
        case let .button(id):
            if let b = card?.buttons.first(where: { $0.id == id }), b.action == "open", let v = b.value, let url = URL(string: v) {
                onOpenURL?(url)
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
            _ = try await client.sign(link, deviceId: deviceId, signatures: signatures, idempotencyKey: "sign-\(ticket.id)")
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
                phase = .failed(message: error.errorDescription ?? "Something went wrong. Nothing was sent.", steps: [])
            }
        } catch {
            phase = .failed(message: "Something went wrong. Nothing was sent.", steps: [])
        }
    }

    public func decline() async {
        guard let link, phase == .ask else { return }
        do {
            _ = try await client.decline(link, reason: nil, idempotencyKey: "decline-\(link.approvalId)")
            await load()
        } catch let error as PennyError {
            phase = .failed(message: error.errorDescription ?? "Couldn't say no just now.", steps: [])
        } catch {
            phase = .failed(message: "Couldn't say no just now.", steps: [])
        }
    }

    /// "Get a new card": the engine checks Guard again and sends a fresh card to the thread.
    public func renew() async {
        do {
            try await client.renew(token)
            note = "A new card is on its way."
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
            try await client.press(token, buttonId: buttonId)
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
        approval.actions.enumerated().map { index, action in
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
