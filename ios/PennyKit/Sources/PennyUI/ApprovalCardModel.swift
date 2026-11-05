import Foundation
import PennyCore
import SwiftUI

/// Drives one approval card: load → ask → Face ID → sign → submit → poll → done.
@MainActor
public final class ApprovalCardModel: ObservableObject {
    @Published public private(set) var approval: Approval?
    @Published public private(set) var phase: CardPhase = .loading
    @Published public private(set) var now = Date()
    /// The decoded actions the device is about to sign (shown in details, not server prose).
    @Published public private(set) var signingPreview: [ActionSummary] = []

    public let link: CardLink
    private let client: EngineClient
    private let signer: MessageSigner
    private let expectedAccountId: String?
    private var clock: Timer?
    private var pollTask: Task<Void, Never>?

    /// Called when Face ID can't run in the current presentation (transcript bubble). The host
    /// should switch to the expanded presentation and let the user tap again.
    public var onNeedsExpandedPresentation: (() -> Void)?

    public init(link: CardLink, client: EngineClient, signer: MessageSigner, expectedAccountId: String?) {
        self.link = link
        self.client = client
        self.signer = signer
        self.expectedAccountId = expectedAccountId
    }

    // No deinit: callers invoke stop() when the card leaves the screen (timer and poller hold self weakly).

    // MARK: Derived

    public var content: CardContent? {
        guard let approval else { return nil }
        return CardContent(approval: approval, trailing: countdownText)
    }

    /// "1:55" until the quote expires.
    public var countdownText: String {
        guard let approval else { return "" }
        let remaining = max(0, Int(approval.expiresAt.timeIntervalSince(now).rounded(.down)))
        return String(format: "%d:%02d", remaining / 60, remaining % 60)
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
        if phase == .ask, let approval, approval.expiresAt <= now {
            phase = .expired
        }
    }

    public func load() async {
        do {
            let fetched = try await client.approval(link)
            approval = fetched
            signingPreview = ActionSummary.describe(fetched)
            apply(status: fetched.status, steps: [])
            if fetched.status == .signed || fetched.status == .relayed { startPolling() }
        } catch let error as PennyError {
            phase = .unavailable(message: error.errorDescription ?? "Couldn't load this card.")
        } catch {
            phase = .unavailable(message: "Couldn't load this card.")
        }
    }

    // MARK: Actions

    public func handle(_ action: CardActionID) {
        switch action {
        case .approve, .allowOnce:
            Task { await approve() }
        case .decline, .notMe:
            Task { await decline() }
        default:
            break
        }
    }

    public func approve() async {
        guard let approval else { return }
        switch phase {
        case .ask, .failed: break
        default: return
        }
        phase = .approving
        do {
            let signed = try await ApprovalSigning.sign(approval, with: signer, expectedAccountId: expectedAccountId)
            let status = try await client.submit(link, signed: signed, idempotencyKey: "submit-\(approval.id)")
            apply(status: status, steps: [StatusStep(label: "Signed on this iPhone", state: .done)])
            startPolling()
        } catch let error as PennyError {
            switch error {
            case .userCancelled:
                phase = .ask
            case .notInteractive:
                phase = .ask
                onNeedsExpandedPresentation?()
            case .expired:
                phase = .expired
            case .notPending:
                await load()
            default:
                phase = .failed(message: error.errorDescription ?? "Something went wrong.", steps: [])
            }
        } catch {
            phase = .failed(message: "Something went wrong. Nothing was sent.", steps: [])
        }
    }

    public func decline() async {
        guard approval != nil, phase == .ask else { return }
        do {
            let status = try await client.decline(link, reason: nil, idempotencyKey: "decline-\(link.approvalId)")
            apply(status: status, steps: [])
        } catch let error as PennyError {
            phase = .failed(message: error.errorDescription ?? "Couldn't decline.", steps: [])
        } catch {
            phase = .failed(message: "Couldn't decline.", steps: [])
        }
    }

    // MARK: Status

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            var delay: UInt64 = 1_200_000_000
            for _ in 0..<120 { // ~3-4 minutes max
                try? await Task.sleep(nanoseconds: delay)
                guard !Task.isCancelled, let self else { return }
                do {
                    let response = try await self.client.status(self.link)
                    self.apply(status: response.status, steps: response.steps)
                    if response.status.isTerminal { return }
                } catch {
                    // Transient: keep polling with backoff.
                }
                delay = min(delay + 300_000_000, 3_000_000_000)
            }
        }
    }

    private func apply(status: ApprovalStatus, steps: [StatusStep]) {
        switch status {
        case .pending:
            phase = (approval?.expiresAt ?? .distantPast) > Date() ? .ask : .expired
        case .signed, .relayed:
            phase = .approved(steps: steps.isEmpty ? [StatusStep(label: "Sent to NEAR", state: .active)] : steps)
        case .settled:
            phase = .done(steps: steps, at: Date())
        case .failed:
            phase = .failed(message: "It didn't go through. Nothing left your wallet.", steps: steps)
        case .expired:
            phase = .expired
        case .cancelled:
            phase = .declined
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
            case let .functionCall(methodName, args, gas, deposit):
                var lines = ["Contract: \(approval.receiverId)", "From: \(approval.signerId)"]
                for key in args.keys.sorted() {
                    let value = args[key].map { $0.stringValue ?? CanonicalJSON.string($0) } ?? ""
                    lines.append("\(key): \(value.count > 80 ? String(value.prefix(77)) + "…" : value)")
                }
                lines.append("Attached: \(deposit) yoctoNEAR")
                if let g = UInt64(gas) { lines.append("Gas: \(g / 1_000_000_000_000) Tgas") }
                return ActionSummary(id: index, title: "Call \(methodName)", lines: lines)
            case let .transfer(deposit):
                return ActionSummary(id: index, title: "Transfer NEAR", lines: [
                    "To: \(approval.receiverId)", "From: \(approval.signerId)", "Amount: \(deposit) yoctoNEAR",
                ])
            }
        }
    }
}
