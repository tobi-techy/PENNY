import Foundation

/// Device-signed account operations (revoke this iPhone, edit Guard limits,
/// approval history). Messages mirror packages/shared/src/schemas.ts exactly;
/// the engine verifies them with the enrolled device key.
public enum DeviceMessage {
    public static func revoke(accountId: String, deviceId: String, timestamp: Int) -> String {
        "penny-device:revoke:v1:\(accountId):\(deviceId):\(timestamp)"
    }
    public static func policy(accountId: String, perTx: String, daily: String, blockNew: String, timestamp: Int) -> String {
        "penny-policy:v1:\(accountId):\(perTx):\(daily):\(blockNew):\(timestamp)"
    }
    public static func history(accountId: String, timestamp: Int) -> String {
        "penny-history:v1:\(accountId):\(timestamp)"
    }
}

public struct ApprovalHistoryItem: Equatable, Sendable {
    public let id: String
    public let kind: String
    public let title: String
    public let amountDisplay: String
    public let status: String
    public let createdAt: String
}

extension EngineClient {
    private func signedBody(
        _ signer: MessageSigner, message: String, accountId: String, timestamp: Int, reason: String
    ) async throws -> [String: JSONValue] {
        let signature = try await signer.sign(Data(message.utf8), reason: reason)
        return [
            "accountId": .string(accountId),
            "timestamp": .number(Double(timestamp)),
            "signature": .string(signature.base64URLEncodedString()),
        ]
    }

    /// Revoke a device (this one, or a lost one) so it can no longer sign.
    public func revokeDevice(
        accountId: String, deviceId: String, signer: MessageSigner, now: Date = Date()
    ) async throws {
        let ts = Int(now.timeIntervalSince1970)
        var body = try await signedBody(
            signer, message: DeviceMessage.revoke(accountId: accountId, deviceId: deviceId, timestamp: ts),
            accountId: accountId, timestamp: ts, reason: "Remove this iPhone")
        body["deviceId"] = .string(deviceId)
        _ = try await send("POST", "/v1/devices/revoke", body: CanonicalJSON.data(.object(body)), idempotencyKey: nil)
    }

    /// Edit Guard limits. Values are decimal USD strings, e.g. "25".
    public func updateGuardPolicy(
        accountId: String, perTxUsd: String, dailyUsd: String, blockNewUsd: String,
        signer: MessageSigner, now: Date = Date()
    ) async throws {
        let ts = Int(now.timeIntervalSince1970)
        var body = try await signedBody(
            signer,
            message: DeviceMessage.policy(accountId: accountId, perTx: perTxUsd, daily: dailyUsd, blockNew: blockNewUsd, timestamp: ts),
            accountId: accountId, timestamp: ts, reason: "Change your limits")
        body["perTxUsd"] = .string(perTxUsd)
        body["dailyUsd"] = .string(dailyUsd)
        body["blockNewRecipientsOverUsd"] = .string(blockNewUsd)
        _ = try await send("POST", "/v1/me/guard-policy", body: CanonicalJSON.data(.object(body)), idempotencyKey: nil)
    }

    /// Recent approvals for the history screen.
    public func approvalHistory(
        accountId: String, signer: MessageSigner, now: Date = Date()
    ) async throws -> [ApprovalHistoryItem] {
        let ts = Int(now.timeIntervalSince1970)
        let body = try await signedBody(
            signer, message: DeviceMessage.history(accountId: accountId, timestamp: ts),
            accountId: accountId, timestamp: ts, reason: "See your history")
        let data = try await send("POST", "/v1/me/approvals", body: CanonicalJSON.data(.object(body)), idempotencyKey: nil)
        let root = try JSONParser.parse(data)
        guard let items = root["approvals"]?.arrayValue else { throw PennyError.invalidResponse("history") }
        return try items.map { item in
            let o = try StrictObject(item, context: "history", allowed: ["id", "kind", "title", "amountDisplay", "status", "txHash", "createdAt"])
            return ApprovalHistoryItem(
                id: try o.string("id"), kind: try o.string("kind"), title: try o.string("title"),
                amountDisplay: try o.string("amountDisplay"), status: try o.string("status"),
                createdAt: try o.string("createdAt"))
        }
    }
}
