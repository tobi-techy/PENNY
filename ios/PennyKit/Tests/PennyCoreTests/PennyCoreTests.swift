import Foundation
import XCTest
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
@testable import PennyCore

// MARK: - Fixtures

private struct DelegateVector {
    let name: String
    let seed: Data
    let publicKey: String
    let publicKeyBase64Url: String
    let senderId: String
    let receiverId: String
    let actions: [ApprovalAction]
    let nonce: String
    let maxBlockHeight: String
    let signableMessage: Data
    let signableHash: Data
    let signature: Data
    let signedBase64: String
}

private func fixtureURL(_ name: String) throws -> URL {
    if let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") { return url }
    if let url = Bundle.module.url(forResource: name, withExtension: "json") { return url }
    throw XCTSkip("fixture \(name) not bundled")
}

private func loadDelegateVectors() throws -> [DelegateVector] {
    let root = try JSONParser.parse(Data(contentsOf: fixtureURL("delegate-vectors")))
    XCTAssertEqual(root["prefix"], .number(1_073_742_190))
    return try (root["vectors"]?.arrayValue ?? []).map { v in
        let d = v["delegate"]!
        return DelegateVector(
            name: v["name"]!.stringValue!,
            seed: Data(hex: v["seedHex"]!.stringValue!)!,
            publicKey: v["publicKey"]!.stringValue!,
            publicKeyBase64Url: v["publicKeyBase64Url"]!.stringValue!,
            senderId: d["senderId"]!.stringValue!,
            receiverId: d["receiverId"]!.stringValue!,
            actions: try d["actions"]!.arrayValue!.map(Approval.parseAction),
            nonce: d["nonce"]!.stringValue!,
            maxBlockHeight: d["maxBlockHeight"]!.stringValue!,
            signableMessage: Data(hex: v["signableMessageHex"]!.stringValue!)!,
            signableHash: Data(hex: v["signableHashHex"]!.stringValue!)!,
            signature: Data(hex: v["signatureHex"]!.stringValue!)!,
            signedBase64: v["signedDelegateActionBase64"]!.stringValue!
        )
    }
}

/// ../packages/shared/test-vectors relative to this file (ios/PennyKit/Tests/PennyCoreTests/…).
private func sharedVectorsDirectory() -> URL {
    if let override = ProcessInfo.processInfo.environment["PENNY_SHARED_VECTORS"] {
        return URL(fileURLWithPath: override)
    }
    return URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // PennyCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // PennyKit
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent() // penny
        .appendingPathComponent("packages/shared/test-vectors")
}

// MARK: - Base58 / base64url / U128 / Borsh

final class EncodingTests: XCTestCase {
    func testBase58KnownValues() {
        XCTAssertEqual(Base58.encode(Data("hello world".utf8)), "StV1DL6CwTryKyV")
        XCTAssertEqual(Base58.encode(Data([0, 0, 1])), "112")
        XCTAssertEqual(Base58.encode(Data()), "")
        XCTAssertEqual(Base58.decode("StV1DL6CwTryKyV"), Data("hello world".utf8))
        XCTAssertEqual(Base58.decode("112"), Data([0, 0, 1]))
        XCTAssertNil(Base58.decode("0OIl"))
    }

    func testBase58RoundTrip() {
        for length in [1, 2, 31, 32, 33, 64] {
            let data = Data((0..<length).map { UInt8(($0 * 37 + 11) % 256) })
            XCTAssertEqual(Base58.decode(Base58.encode(data)), data)
        }
    }

    func testBase64URLStrict() {
        let data = Data([0xfb, 0xff, 0x00, 0x10])
        XCTAssertEqual(data.base64URLEncodedString(), "-_8AEA")
        XCTAssertEqual(Data(base64URLEncoded: "-_8AEA"), data)
        XCTAssertNil(Data(base64URLEncoded: "-_8AEA=="))
        XCTAssertNil(Data(base64URLEncoded: "+/8AEA"))
    }

    func testU128() {
        XCTAssertEqual(U128(decimal: "0"), U128(low: 0))
        XCTAssertEqual(U128(decimal: "18446744073709551615"), U128(low: .max))
        XCTAssertEqual(U128(decimal: "18446744073709551616"), U128(low: 0, high: 1))
        XCTAssertEqual(U128(decimal: "340282366920938463463374607431768211455"), U128(low: .max, high: .max))
        XCTAssertNil(U128(decimal: "340282366920938463463374607431768211456"))
        XCTAssertNil(U128(decimal: "01"))
        XCTAssertNil(U128(decimal: "1.5"))
        XCTAssertNil(U128(decimal: ""))
        XCTAssertEqual(U128(decimal: "1500000000000000000000000")?.description, "1500000000000000000000000")
    }

    func testBorshPrimitives() {
        var w = BorshWriter()
        w.u32(1_073_742_190)
        XCTAssertEqual(w.data.hexString, "6e010040")
        w = BorshWriter()
        w.string("abc")
        XCTAssertEqual(w.data.hexString, "03000000616263")
        w = BorshWriter()
        w.u128(U128(decimal: "1")!)
        XCTAssertEqual(w.data.hexString, "01000000000000000000000000000000")
    }

    func testAccountIds() {
        for ok in ["tobi.penny.near", "ada.near", "a-b_c.near", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"] {
            XCTAssertTrue(NearAccountID.isValid(ok), ok)
        }
        for bad in ["a", "Tobi.near", "-a.near", "a..near", "a.near.", "a b.near", "a--b.near"] {
            XCTAssertFalse(NearAccountID.isValid(bad), bad)
        }
    }
}

// MARK: - NEP-366 delegate actions

final class DelegateActionTests: XCTestCase {
    func testPrefixIsNEP461() {
        XCTAssertEqual(DelegateAction.nep461Prefix, 1_073_742_190)
    }

    func testVectorsMatchNearAPIJS() throws {
        let vectors = try loadDelegateVectors()
        XCTAssertFalse(vectors.isEmpty)
        for v in vectors {
            let signer = try InMemorySigner(seed: v.seed)
            let pk = try signer.publicKey()
            XCTAssertEqual(pk.nearString, v.publicKey, v.name)
            XCTAssertEqual(pk.base64URL, v.publicKeyBase64Url, v.name)

            let delegate = try DelegateAction(
                senderId: v.senderId,
                receiverId: v.receiverId,
                actions: try v.actions.map { try $0.nearAction() },
                nonce: UInt64(v.nonce)!,
                maxBlockHeight: UInt64(v.maxBlockHeight)!,
                publicKey: pk
            )
            XCTAssertEqual(delegate.signableMessage().hexString, v.signableMessage.hexString, v.name)
            XCTAssertEqual(delegate.signableHash(), v.signableHash, v.name)

            // Reference signature (deterministic, from node) verifies with our key and hash.
            let verifyKey = try Curve25519.Signing.PublicKey(rawRepresentation: pk.raw)
            XCTAssertTrue(verifyKey.isValidSignature(v.signature, for: delegate.signableHash()), v.name)

            // Assembling with the reference signature gives byte-identical SignedDelegateAction.
            let signed = try SignedDelegateAction(delegateAction: delegate, signature: v.signature)
            XCTAssertEqual(signed.base64, v.signedBase64, v.name)
        }
    }

    func testApprovalSigningProducesVerifiableSignature() async throws {
        let v = try XCTUnwrap(try loadDelegateVectors().first)
        let signer = try InMemorySigner(seed: v.seed)
        let approval = Approval(
            id: "apr_01JC0000000000000000000000", userId: "usr_01JC0000000000000000000000", kind: .invest,
            title: "Swap · USDC → ETH Momentum", amountDisplay: "$50.00", facts: [],
            signerId: v.senderId, receiverId: v.receiverId, actions: v.actions, nonce: v.nonce,
            maxBlockHeight: v.maxBlockHeight, expiresAt: Date().addingTimeInterval(60), status: .pending,
            planHash: String(repeating: "A", count: 43)
        )
        let signed = try await ApprovalSigning.sign(approval, with: signer, expectedAccountId: v.senderId)
        XCTAssertEqual(signed.delegateAction.signableHash(), v.signableHash)
        // ed25519 signatures may be randomized on Apple platforms, so compare the unsigned part only.
        let borsh = signed.borsh()
        let refBorsh = Data(base64Encoded: v.signedBase64)!
        XCTAssertEqual(borsh.prefix(borsh.count - 64), refBorsh.prefix(refBorsh.count - 64))
        XCTAssertEqual(approval.faceIDReason, "Approve $50.00 · Swap · USDC → ETH Momentum")
    }

    func testSigningRefusesExpiredAndWrongAccount() async throws {
        let signer = InMemorySigner()
        let base = Approval(
            id: "apr_01JC0000000000000000000000", userId: "usr_01JC0000000000000000000000", kind: .send,
            title: "To Ada · ada.near", amountDisplay: "$20.00", facts: [], signerId: "tobi.penny.near",
            receiverId: "ada.near", actions: [.transfer(deposit: "1")], nonce: "1", maxBlockHeight: "10",
            expiresAt: Date().addingTimeInterval(-1), status: .pending, planHash: String(repeating: "A", count: 43)
        )
        do {
            _ = try await ApprovalSigning.sign(base, with: signer, expectedAccountId: nil)
            XCTFail("expected expiry")
        } catch let e as PennyError { XCTAssertEqual(e, .expired) }

        let fresh = Approval(id: base.id, userId: base.userId, kind: base.kind, title: base.title, amountDisplay: base.amountDisplay,
                             facts: [], signerId: base.signerId, receiverId: base.receiverId, actions: base.actions,
                             nonce: "1", maxBlockHeight: "10", expiresAt: Date().addingTimeInterval(60), status: .pending,
                             planHash: base.planHash)
        do {
            _ = try await ApprovalSigning.sign(fresh, with: signer, expectedAccountId: "someone.penny.near")
            XCTFail("expected wrong account")
        } catch let e as PennyError { XCTAssertEqual(e, .wrongAccount) }
    }
}

// MARK: - Approval parsing

final class ApprovalParsingTests: XCTestCase {
    let json = """
    {"id":"apr_01JC2ZK5Y8T3M4N5P6Q7R8S9TV","userId":"usr_01JC2ZK5Y8T3M4N5P6Q7R8S9TV","kind":"invest",
     "plan":{"kind":"invest","fromAsset":"USDC","amountUsd":"50","portfolioId":"eth-momentum","quoteId":"q_1"},
     "title":"Swap · USDC → ETH Momentum","amountDisplay":"$50.00",
     "facts":[{"label":"Fee","value":"$0.12"},{"label":"Today's limit","value":"$50 of $100 left"}],
     "signerId":"tobi.penny.near","receiverId":"usdc.near",
     "actions":[{"type":"FunctionCall","methodName":"ft_transfer_call","args":{"receiver_id":"intents.near","amount":"50000000","msg":"{}"},"gas":"30000000000000","deposit":"1"}],
     "nonce":"1234","maxBlockHeight":"123456789","expiresAt":"2026-11-05T19:00:00.000Z","status":"pending",
     "planHash":"zFHz3XmzCjVgKCyFWHSGWeYKVWbi_zGLUgD3rJxZnAQ"}
    """

    func testParsesApproval() throws {
        let a = try Approval.parse(Data(json.utf8))
        XCTAssertEqual(a.kind, .invest)
        XCTAssertEqual(a.facts.count, 2)
        XCTAssertEqual(a.actions.count, 1)
        XCTAssertEqual(a.status, .pending)
    }

    func testRejectsTamperedPlanHash() {
        // planHash computed over {plan, actions} on-device: tampering with the
        // amount in transit must fail before Face ID ever signs.
        let bad = json.replacingOccurrences(of: "\"amountUsd\":\"50\"", with: "\"amountUsd\":\"5000\"")
        XCTAssertThrowsError(try Approval.parse(Data(bad.utf8)))
    }

    func testRejectsUnknownKeys() {
        let bad = json.replacingOccurrences(of: "\"status\":\"pending\"", with: "\"status\":\"pending\",\"extra\":1")
        XCTAssertThrowsError(try Approval.parse(Data(bad.utf8)))
    }

    func testRejectsDisallowedActions() {
        let bad = json.replacingOccurrences(of: "\"type\":\"FunctionCall\"", with: "\"type\":\"AddKey\"")
        XCTAssertThrowsError(try Approval.parse(Data(bad.utf8)))
    }

    func testRejectsBadIds() {
        let bad = json.replacingOccurrences(of: "apr_01JC2ZK5Y8T3M4N5P6Q7R8S9TV", with: "apr_../../admin")
        XCTAssertThrowsError(try Approval.parse(Data(bad.utf8)))
    }

    func testCardLink() {
        let url = URL(string: "https://penny.example/c?approvalId=apr_01JC2ZK5Y8T3M4N5P6Q7R8S9TV&cardToken=\(String(repeating: "x", count: 43))")!
        XCTAssertNotNil(CardLink(url: url))
        let engineForm = URL(string: "https://penny.example/a/apr_01JC2ZK5Y8T3M4N5P6Q7R8S9TV#t=\(String(repeating: "y", count: 43))")!
        XCTAssertEqual(CardLink(url: engineForm)?.approvalId, "apr_01JC2ZK5Y8T3M4N5P6Q7R8S9TV")
        XCTAssertEqual(CardLink(url: engineForm)?.cardToken, String(repeating: "y", count: 43))
        XCTAssertNil(CardLink(url: URL(string: "https://penny.example/c?approvalId=nope&cardToken=x")!))
    }

    func testEnrollCode() {
        XCTAssertEqual(EnrollCode.normalize("ab-cd ef 23x"), "ABCDEF23")
        XCTAssertTrue(EnrollCode.isValid("ABCDEF23"))
        XCTAssertFalse(EnrollCode.isValid("ABCDEF2O")) // O is not in the alphabet
    }
}

// MARK: - RFC 8785

final class CanonicalJSONTests: XCTestCase {
    func testRFC8785Sample() throws {
        let input = #"{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/","literals":[null,true,false]}"#
        let expected = #"{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}"#
        XCTAssertEqual(try CanonicalJSON.canonicalize(input), expected)
    }

    func testNumbers() {
        let cases: [(Double, String)] = [
            (0, "0"), (-0.0, "0"), (1, "1"), (-1, "-1"), (1.5, "1.5"), (1e21, "1e+21"), (1e20, "100000000000000000000"),
            (1e-7, "1e-7"), (0.000001, "0.000001"), (0.1, "0.1"), (100, "100"), (9007199254740991, "9007199254740991"),
            (-12.25, "-12.25"), (5e-324, "5e-324"), (1.7976931348623157e308, "1.7976931348623157e+308"), (1.2345678901234568e20, "123456789012345680000"),
            (0.30000000000000004, "0.30000000000000004"), (1.5e-10, "1.5e-10"),
        ]
        for (value, expected) in cases {
            XCTAssertEqual(CanonicalJSON.ecmaScriptNumber(value), expected, "\(value)")
        }
    }

    func testRejectsLoneSurrogateAndDuplicates() {
        XCTAssertThrowsError(try JSONParser.parse(#"{"bad":"\ud800"}"#))
        XCTAssertThrowsError(try JSONParser.parse(#"{"a":1,"a":2}"#))
        XCTAssertThrowsError(try JSONParser.parse("[1,]"))
        XCTAssertThrowsError(try JSONParser.parse("1e400"))
    }

    /// Shared vectors written by packages/shared (same files the TypeScript tests use).
    func testSharedVectors() throws {
        let dir = sharedVectorsDirectory()
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
            .filter({ $0.pathExtension == "json" }).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }),
            !files.isEmpty else {
            throw XCTSkip("no shared vectors at \(dir.path)")
        }
        for file in files {
            let vector = try JSONParser.parse(Data(contentsOf: file))
            guard let input = vector["input"]?.stringValue else { continue }
            let name = file.lastPathComponent
            if vector["expectError"] == .bool(true) {
                XCTAssertThrowsError(try CanonicalJSON.canonicalize(input), name)
                continue
            }
            let canonical = try CanonicalJSON.canonicalize(input)
            if let expected = vector["canonical"]?.stringValue {
                XCTAssertEqual(canonical, expected, name)
            }
            if let hash = vector["sha256Base64Url"]?.stringValue {
                XCTAssertEqual(CanonicalJSON.sha256Base64URL(try JSONParser.parse(input)), hash, name)
            }
        }
    }
}
