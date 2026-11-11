import Foundation
import XCTest
@testable import PennyCore
@testable import PennyUI

/// The whole Face ID path without a network: load a live card, sign, post, settle,
/// cancel, lose the connection after POST, unfreeze, and a refresh blip.
@MainActor
final class ApprovalCardModelTests: XCTestCase {
    private let token = CardToken(String(repeating: "A", count: 42) + "Q")!

    private func model(_ client: FakeCardClient, signer: MessageSigner = InMemorySigner()) -> ApprovalCardModel {
        ApprovalCardModel(token: token, client: client, signer: signer,
                          expectedAccountId: "tobi.testnet", deviceId: "dev_test")
    }

    func testLoadApproveSignPostSettle() async throws {
        let client = FakeCardClient([.success(try card(.ready)), .success(try card(.sent))])
        let m = model(client)
        await m.load()
        XCTAssertEqual(m.phase, .ask)
        XCTAssertEqual(m.card?.state, .ready)

        await m.approve()

        XCTAssertEqual(client.signCalls, 1)
        XCTAssertEqual(client.lastDeviceId, "dev_test")
        XCTAssertNotNil(client.lastSignatures?.signature)
        guard case .done = m.phase else { return XCTFail("expected done, got \(m.phase)") }
        XCTAssertEqual(m.card?.state, .sent)
    }

    func testFaceIDCancelStaysReadyAndPostsNothing() async throws {
        let client = FakeCardClient([.success(try card(.ready))])
        let m = model(client, signer: CancelSigner())
        await m.load()
        await m.approve()
        XCTAssertEqual(m.phase, .ask)
        XCTAssertEqual(client.signCalls, 0)
    }

    func testConnectionDroppedAfterPostShowsFailedNotSuccess() async throws {
        let client = FakeCardClient([.success(try card(.ready))])
        client.signError = URLError(.networkConnectionLost)
        let m = model(client)
        await m.load()
        await m.approve()
        guard case let .failed(message, _) = m.phase else {
            return XCTFail("expected failed, got \(m.phase)")
        }
        XCTAssertFalse(message.isEmpty)
        XCTAssertEqual(m.card?.state, .ready, "a dropped reply never claims the card settled")
    }

    func testDeclinePostsAndShowsDeclined() async throws {
        let client = FakeCardClient([.success(try card(.ready)), .success(try card(.declined))])
        let m = model(client)
        await m.load()
        await m.decline()
        XCTAssertEqual(client.declineCalls, 1)
        XCTAssertEqual(m.phase, .declined)
    }

    func testUnfreezeFailureKeepsPennyFrozen() async throws {
        let client = FakeCardClient([.success(try unfreezeCard()), .success(try unfreezeCard())])
        client.unfreezeError = PennyError.http(status: 500)
        let m = model(client)
        await m.load()
        XCTAssertEqual(m.phase, .info)
        await m.unfreeze()
        XCTAssertEqual(client.unfreezeCalls, 1)
        XCTAssertEqual(m.note, "That didn't check out. Penny is still frozen. Text unfreeze for a new card.")
    }

    func testRefreshBlipKeepsTheCardOnScreen() async throws {
        let client = FakeCardClient([.success(try card(.ready))])
        let m = model(client)
        await m.load()
        client.cardError = PennyError.invalidResponse("offline")
        await m.load()
        XCTAssertEqual(m.phase, .ask)
        XCTAssertEqual(m.note, "couldn't refresh this card. it will catch up in a moment.")
    }

    func testFirstLoadFailureIsUnavailable() async throws {
        let client = FakeCardClient([])
        client.cardError = PennyError.invalidResponse("offline")
        let m = model(client)
        await m.load()
        guard case .unavailable = m.phase else { return XCTFail("expected unavailable") }
    }
}

private final class FakeCardClient: ApprovalCardClient, @unchecked Sendable {
    private var responses: [Result<CardByToken, Error>]
    var cardError: Error?
    var signError: Error?
    var unfreezeError: Error?
    var signCalls = 0
    var declineCalls = 0
    var unfreezeCalls = 0
    var lastDeviceId: String?
    var lastSignatures: ApprovalSignatures?

    init(_ responses: [Result<CardByToken, Error>]) { self.responses = responses }

    func card(_ token: CardToken) async throws -> CardByToken {
        if let cardError { throw cardError }
        guard !responses.isEmpty else { throw PennyError.invalidResponse("no response") }
        return try responses.removeFirst().get()
    }

    func freshPrice(_ token: CardToken) async throws {}

    func sign(_ link: CardLink, deviceId: String, signatures: ApprovalSignatures) async throws -> ApprovalStatus {
        signCalls += 1
        lastDeviceId = deviceId
        lastSignatures = signatures
        if let signError { throw signError }
        return .signed
    }

    func decline(_ link: CardLink, reason: String?) async throws -> ApprovalStatus {
        declineCalls += 1
        return .cancelled
    }

    func unfreeze(_ token: CardToken, deviceId: String, signature: Data) async throws {
        unfreezeCalls += 1
        if let unfreezeError { throw unfreezeError }
    }

    func press(_ token: CardToken, buttonId: String, confirm: Bool) async throws {}

    func renew(_ token: CardToken) async throws -> String? { nil }

    func status(_ link: CardLink) async throws -> ApprovalStatusResponse {
        throw PennyError.invalidResponse("status not used")
    }
}

private struct CancelSigner: MessageSigner {
    func publicKey() throws -> NearPublicKey { try InMemorySigner().publicKey() }
    func sign(_ message: Data, reason: String) async throws -> Data { throw PennyError.userCancelled }
}

private func card(_ state: CardState) throws -> CardByToken {
    try CardByToken.parse(ticketJSON(state: state))
}

private func unfreezeCard() throws -> CardByToken {
    let challenge = String(repeating: "B", count: 42) + "A"
    let body: JSONValue = .object([
        "card": .object([
            "id": .string("crd_01JC0000000000000000000000"),
            "title": .string("Unfreeze Penny"),
            "type": .string("unfreeze"),
            "kind": .string("info"),
            "state": .string("ready"),
            "buttons": .array([.object([
                "id": .string("unfreeze"),
                "label": .string("Unfreeze with Face ID"),
                "action": .string("unfreeze"),
            ])]),
        ]),
        "unfreeze": .object(["challenge": .string(challenge)]),
    ])
    return try CardByToken.parse(CanonicalJSON.data(body))
}

/// A ticket exactly as GET /v1/approvals/by-token/:token returns it, with real hashes.
private func ticketJSON(state: CardState) -> Data {
    let id = "apr_01JC0000000000000000000000"
    let expiresAt = "2099-01-01T00:10:00.000Z"
    let plan: JSONValue = .object([
        "kind": .string("send"),
        "asset": .string("NEAR"),
        "amount": .string("0.1"),
        "to": .string("amara.testnet"),
    ])
    let actions: JSONValue = .array([.object([
        "type": .string("Transfer"),
        "deposit": .string("100000000000000000000000"),
    ])])
    let planHash = CanonicalJSON.sha256Base64URL(.object(["plan": plan, "actions": actions]))
    let intent = ApprovalIntent.from(plan: plan)!
    let hash = ApprovalHash.compute(id: id, action: intent, expiresAt: expiresAt, planHash: planHash)
    let detail: JSONValue = .object([
        "id": .string(id),
        "userId": .string("usr_01JC0000000000000000000000"),
        "kind": .string("send"),
        "plan": plan,
        "title": .string("Send NEAR · amara.testnet"),
        "amountDisplay": .string("$0.40"),
        "facts": .array([.object(["label": .string("To"), "value": .string("amara.testnet")])]),
        "signerId": .string("tobi.testnet"),
        "receiverId": .string("amara.testnet"),
        "actions": actions,
        "nonce": .string("1001"),
        "maxBlockHeight": .string("200000000"),
        "expiresAt": .string(expiresAt),
        "status": .string("pending"),
        "planHash": .string(planHash),
    ])
    let approval: JSONValue = .object([
        "id": .string(id),
        "action": intent.json,
        "approvalHash": .string(hash),
        "expiresAt": .string(expiresAt),
        "status": .string("pending"),
        "challenge": .string("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"),
        "detail": detail,
    ])
    let card: JSONValue = .object([
        "id": .string("crd_01JC0000000000000000000000"),
        "userId": .string("usr_01JC0000000000000000000000"),
        "agent": .string("penny"),
        "kind": .string("approval"),
        "type": .string("send"),
        "title": .string("Send 0.1 NEAR"),
        "amount": .string("0.1 NEAR"),
        "lines": .array([.object(["label": .string("To"), "value": .string("amara.testnet")])]),
        "buttons": .array([.object([
            "id": .string("approve"),
            "label": .string("Approve with Face ID"),
            "action": .string("approve"),
        ])]),
        "state": .string(state.rawValue),
        "approvalId": .string(id),
        "expiresAt": .string(expiresAt),
        "createdAt": .string("2026-11-05T19:00:00.000Z"),
    ])
    return CanonicalJSON.data(.object(["card": card, "approval": approval]))
}
