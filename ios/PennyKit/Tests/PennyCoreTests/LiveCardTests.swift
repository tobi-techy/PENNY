import Foundation
import XCTest
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
@testable import PennyCore

/// Live cards: the token in the card URL, the approval hash + challenge the phone signs, and
/// the card states. Engine side: apps/engine/src/approvals/service.ts (signWithDevice).

private func vectorsDir() -> URL {
    if let override = ProcessInfo.processInfo.environment["PENNY_SHARED_VECTORS"] {
        return URL(fileURLWithPath: override)
    }
    return URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("packages/shared/test-vectors")
}

// Test-only literals so fixtures read like the JSON the engine sends.
extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}

// a made-up 43-char base64url card token (built, not a literal, so it never looks like a secret)
private let token43 = String(repeating: "A", count: 42) + "Q"

final class CardTokenTests: XCTestCase {
    func testParsesTheTokenFromTheCardURL() {
        let url = URL(string: "https://penny.example/a/\(token43)")!
        XCTAssertEqual(CardToken(url: url)?.value, token43)
    }

    func testFreshLinkCardsCarryAVersionSuffix() {
        let url = URL(string: "https://penny.example/a/\(token43)?v=sent-2")!
        XCTAssertEqual(CardToken(url: url)?.value, token43)
    }

    func testHostIsIgnoredAndAPathPrefixIsFine() {
        XCTAssertEqual(CardToken(url: URL(string: "https://other.host/penny/a/\(token43)")!)?.value, token43)
    }

    func testRejectsShortTokensApprovalIdsAndOtherPaths() {
        XCTAssertNil(CardToken(url: URL(string: "https://penny.example/a/short")!))
        XCTAssertNil(CardToken(url: URL(string: "https://penny.example/a/apr_01JC0000000000000000000000")!))
        XCTAssertNil(CardToken(url: URL(string: "https://penny.example/setup#code=ABCDEFGH")!))
        XCTAssertNil(CardToken(token43 + "x"))
        XCTAssertNil(CardToken(String(token43.dropLast()) + "!"))
    }

    func testOldLinksStillParseAsLegacyCardLinks() {
        let old = URL(string: "https://penny.example/a/apr_01JC0000000000000000000000#t=\(token43)")!
        XCTAssertNil(CardToken(url: old))
        XCTAssertNotNil(CardLink(url: old))
    }
}

final class ApprovalHashTests: XCTestCase {
    func testMatchesTheSharedVector() throws {
        let url = vectorsDir().appendingPathComponent("09-approval-hash.json")
        let v = try JSONParser.parse(Data(contentsOf: url))
        let input = try JSONParser.parse(v["input"]!.stringValue!)
        let action = ApprovalIntent(
            type: input["action"]!["type"]!.stringValue!, to: input["action"]!["to"]!.stringValue!,
            amount: input["action"]!["amount"]!.stringValue!, asset: input["action"]!["asset"]!.stringValue!)
        let hash = ApprovalHash.compute(id: input["id"]!.stringValue!, action: action,
                                        expiresAt: input["expiresAt"]!.stringValue!, planHash: input["planHash"]!.stringValue!)
        XCTAssertEqual(hash, v["sha256Base64Url"]!.stringValue!)
        XCTAssertEqual(CanonicalJSON.string(.object([
            "action": action.json, "expiresAt": input["expiresAt"]!, "id": input["id"]!, "planHash": input["planHash"]!,
        ])), v["canonical"]!.stringValue!)
        let message = ApprovalHash.message(hash: hash, challenge: v["challenge"]!.stringValue!)
        XCTAssertEqual(String(decoding: message, as: UTF8.self), v["signMessage"]!.stringValue!)
    }

    func testIntentFromEachPlanKind() {
        XCTAssertEqual(ApprovalIntent.from(plan: .object(["kind": "send", "asset": "NEAR", "amount": "0.1", "to": "amara.testnet"])),
                       ApprovalIntent(type: "send", to: "amara.testnet", amount: "0.1", asset: "NEAR"))
        XCTAssertEqual(ApprovalIntent.from(plan: .object(["kind": "write", "toolkit": "gmail", "toolSlug": "GMAIL_SEND_EMAIL",
                                                          "title": "t", "summary": "s", "arguments": .object([:])]))?.to,
                       "gmail:GMAIL_SEND_EMAIL")
        XCTAssertNil(ApprovalIntent.from(plan: .object(["kind": "teleport"])))
    }
}

/// A ticket exactly as GET /v1/approvals/by-token/:token returns it, with real hashes.
private func ticketJSON(challenge: String? = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
                        expiresAt: String = "2099-01-01T00:10:00.000Z",
                        tamperHash: Bool = false, tamperAction: Bool = false) -> Data {
    let id = "apr_01JC0000000000000000000000"
    let plan: JSONValue = .object(["kind": "send", "asset": "NEAR", "amount": "0.1", "to": "amara.testnet"])
    let actions: JSONValue = .array([.object(["type": "Transfer", "deposit": "100000000000000000000000"])])
    let planHash = CanonicalJSON.sha256Base64URL(.object(["plan": plan, "actions": actions]))
    let intent = ApprovalIntent.from(plan: plan)!
    var hash = ApprovalHash.compute(id: id, action: intent, expiresAt: expiresAt, planHash: planHash)
    if tamperHash { hash = String(hash.reversed()) }
    let detail: JSONValue = .object([
        "id": .string(id), "userId": "usr_01JC0000000000000000000000", "kind": "send", "plan": plan,
        "title": "Send NEAR · amara.testnet", "amountDisplay": "$0.40",
        "facts": .array([.object(["label": "To", "value": "amara.testnet"])]),
        "signerId": "tobi.testnet", "receiverId": "amara.testnet", "actions": actions,
        "nonce": "1001", "maxBlockHeight": "200000000", "expiresAt": .string(expiresAt),
        "status": "pending", "planHash": .string(planHash),
    ])
    var approval: [String: JSONValue] = [
        "id": .string(id),
        "action": tamperAction ? .object(["type": "send", "to": "evil.testnet", "amount": "0.1", "asset": "NEAR"]) : intent.json,
        "approvalHash": .string(hash),
        "expiresAt": .string(expiresAt),
        "status": "pending",
        "detail": detail,
    ]
    if let challenge { approval["challenge"] = .string(challenge) }
    let card: JSONValue = .object([
        "id": "crd_01JC0000000000000000000000", "userId": "usr_01JC0000000000000000000000", "agent": "penny",
        "kind": "approval", "type": "send", "title": "Send 0.1 NEAR", "amount": "0.1 NEAR",
        "lines": .array([.object(["label": "To", "value": "amara.testnet"])]),
        "buttons": .array([.object(["id": "approve", "label": "Approve with Face ID", "action": "approve"])]),
        "state": "ready", "approvalId": .string(id), "expiresAt": .string(expiresAt),
        "createdAt": "2026-11-05T19:00:00.000Z",
    ])
    return CanonicalJSON.data(.object(["card": card, "approval": .object(approval)]))
}

final class SignApprovalTests: XCTestCase {
    private let seed = Data(repeating: 7, count: 32)

    func testSignsApprovalHashPlusChallengeAndTheActionBehindOneFaceID() async throws {
        let parsed = try CardByToken.parse(ticketJSON())
        let ticket = try XCTUnwrap(parsed.ticket)
        XCTAssertEqual(ticket.faceIDReason, "Approve sending 0.1 NEAR")
        let signer = try CountingSigner(seed: seed)
        let sigs = try await ApprovalSigning.signForApproval(ticket, with: signer, expectedAccountId: "tobi.testnet")
        XCTAssertEqual(signer.prompts, 1, "one Face ID for both signatures")
        let pub = try Curve25519.Signing.PublicKey(rawRepresentation: try signer.publicKey().raw)
        let message = ApprovalHash.message(hash: ticket.approvalHash, challenge: ticket.challenge!)
        XCTAssertTrue(pub.isValidSignature(sigs.signature, for: message))
        XCTAssertNotNil(sigs.signedDelegateAction)
        XCTAssertNil(sigs.planSignature)
    }

    func testRefusesWithoutAChallengeOrWhenExpiredOrForAnotherAccount() async throws {
        let signer = try CountingSigner(seed: seed)
        let used = try XCTUnwrap(try CardByToken.parse(ticketJSON(challenge: nil)).ticket)
        await XCTAssertThrowsErrorAsync(try await ApprovalSigning.signForApproval(used, with: signer, expectedAccountId: nil))
        let old = try XCTUnwrap(try CardByToken.parse(ticketJSON(expiresAt: "2001-01-01T00:00:00.000Z")).ticket)
        await XCTAssertThrowsErrorAsync(try await ApprovalSigning.signForApproval(old, with: signer, expectedAccountId: nil))
        let ok = try XCTUnwrap(try CardByToken.parse(ticketJSON()).ticket)
        await XCTAssertThrowsErrorAsync(try await ApprovalSigning.signForApproval(ok, with: signer, expectedAccountId: "someone.testnet"))
        XCTAssertEqual(signer.prompts, 0, "Face ID never shows for a card that can't be approved")
    }

    func testAServerHashOrActionThatDoesNotMatchThePlanIsRefused() {
        XCTAssertThrowsError(try CardByToken.parse(ticketJSON(tamperHash: true)))
        XCTAssertThrowsError(try CardByToken.parse(ticketJSON(tamperAction: true)))
    }
}

final class CardStateTests: XCTestCase {
    func testPillsInPlainWords() {
        XCTAssertEqual(CardState.ready.pillTitle, "Approve with Face ID")
        XCTAssertEqual(CardState.ready.secondaryTitle, "Not now")
        XCTAssertEqual(CardState.approving.pillTitle, "Approving…")
        XCTAssertEqual(CardState.sent.pillTitle, "Sent")
        XCTAssertEqual(CardState.expired.pillTitle, "Get a new card")
        XCTAssertEqual(CardState.blocked.pillTitle, "Not me")
        XCTAssertNil(CardState.declined.pillTitle)
        for state in CardState.allCases {
            for text in [state.pillTitle, state.secondaryTitle, state.closingLine].compactMap({ $0 }) {
                XCTAssertNil(text.range(of: #"(?i)\b(nonce|relayer|delegate|transaction|gas|yocto)"#, options: .regularExpression), text)
            }
        }
    }

    func testUnknownTypesAndStatesStillParseAsAPlainCard() throws {
        let card = try PennyCard.parse(.object([
            "title": "Rain at 4pm", "type": "weather_report", "state": "sparkly",
            "lines": .array([.object(["value": "Take a coat."]), .object(["bogus": 1])]),
            "buttons": .array([.object(["id": "open", "label": "Open"]), .object(["nope": true])]),
        ]))
        XCTAssertEqual(card.type, "weather_report")
        XCTAssertEqual(card.state, .done)
        XCTAssertEqual(card.lines, [CardLine(label: nil, value: "Take a coat.")])
        XCTAssertEqual(card.buttons.map(\.id), ["open"])
        XCTAssertThrowsError(try PennyCard.parse(.object(["lines": .array([])])))
    }

    func testReceiptLinksMustBeHTTPS() throws {
        let ok = try PennyCard.parse(.object(["title": "Sent", "receiptUrl": "https://testnet.nearblocks.io/txns/abc"]))
        XCTAssertEqual(ok.receiptURL?.host, "testnet.nearblocks.io")
        let bad = try PennyCard.parse(.object(["title": "Sent", "receiptUrl": "javascript:alert(1)"]))
        XCTAssertNil(bad.receiptURL)
    }

    func testNearAmountsInPlainNumbers() {
        XCTAssertEqual(NearAmount.display(yocto: "100000000000000000000000"), "0.1")
        XCTAssertEqual(NearAmount.display(yocto: "2500000000000000000000000"), "2.5")
        XCTAssertEqual(NearAmount.display(yocto: "1000000000000000000000000"), "1")
        XCTAssertEqual(NearAmount.display(yocto: "1"), "less than 0.000001")
        XCTAssertEqual(NearAmount.display(yocto: "0"), "0")
    }
}

/// Counts Face ID prompts: one per signMany call.
private final class CountingSigner: MessageSigner, @unchecked Sendable {
    private let inner: InMemorySigner
    private(set) var prompts = 0
    init(seed: Data) throws { inner = try InMemorySigner(seed: seed) }
    func publicKey() throws -> NearPublicKey { try inner.publicKey() }
    func sign(_ message: Data, reason: String) async throws -> Data { try await signMany([message], reason: reason)[0] }
    func signMany(_ messages: [Data], reason: String) async throws -> [Data] {
        prompts += 1
        var out: [Data] = []
        for m in messages { out.append(try await inner.sign(m, reason: reason)) }
        return out
    }
}

private func XCTAssertThrowsErrorAsync<T>(_ expression: @autoclosure () async throws -> T,
                                          file: StaticString = #filePath, line: UInt = #line) async {
    do {
        _ = try await expression()
        XCTFail("expected an error", file: file, line: line)
    } catch {}
}
