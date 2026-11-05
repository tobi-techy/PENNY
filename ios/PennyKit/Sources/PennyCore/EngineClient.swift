import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// approvalId + cardToken carried in the live card's URL. Accepted forms:
///   https://<engine>/a/<approvalId>#t=<cardToken>            (engine MessagingPort, apps/engine/src/ports/messaging.ts)
///   https://<engine>/c?approvalId=<id>&cardToken=<token>     (also `a` / `t` query aliases)
/// The URL's host is ignored on purpose: requests always go to the configured engine URL.
/// The fragment form keeps the token out of server/proxy logs.
public struct CardLink: Equatable, Sendable {
    public let approvalId: String
    public let cardToken: String

    public init?(approvalId: String, cardToken: String) {
        guard Validate.approvalId(approvalId), Validate.cardToken(cardToken) else { return nil }
        self.approvalId = approvalId
        self.cardToken = cardToken
    }

    public init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var pairs: [String: String] = [:]
        for item in components.queryItems ?? [] { if let v = item.value { pairs[item.name] = v } }
        if let fragment = components.fragment {
            for part in fragment.split(separator: "&") {
                let kv = part.split(separator: "=", maxSplits: 1).map(String.init)
                if kv.count == 2 { pairs[kv[0]] = kv[1].removingPercentEncoding ?? kv[1] }
            }
        }
        // Path form: .../a/<approvalId>
        let segments = components.path.split(separator: "/").map(String.init)
        var pathId: String?
        if let idx = segments.lastIndex(of: "a"), idx + 1 < segments.count { pathId = segments[idx + 1] }

        guard let id = pairs["approvalId"] ?? pairs["a"] ?? pathId,
              let token = pairs["cardToken"] ?? pairs["t"] else { return nil }
        self.init(approvalId: id, cardToken: token)
    }
}

/// HTTP client for the Penny engine (ARCHITECTURE.md › Engine HTTP API).
/// Never logs tokens, keys or bodies. All responses are parsed strictly.
public struct EngineClient: Sendable {
    public let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    // GET /v1/approvals/:id   (Authorization: Card <cardToken>)
    public func approval(_ link: CardLink) async throws -> Approval {
        let data = try await send("GET", "/v1/approvals/\(link.approvalId)", cardToken: link.cardToken)
        let approval = try Approval.parse(data)
        guard approval.id == link.approvalId else { throw PennyError.invalidResponse("approval id mismatch") }
        return approval
    }

    // POST /v1/approvals/:id/submit  {signedDelegateAction}
    public func submit(_ link: CardLink, signed: SignedDelegateAction, idempotencyKey: String = UUID().uuidString) async throws -> ApprovalStatus {
        let body = CanonicalJSON.data(.object(["signedDelegateAction": .string(signed.base64)]))
        let data = try await send("POST", "/v1/approvals/\(link.approvalId)/submit", cardToken: link.cardToken, body: body, idempotencyKey: idempotencyKey)
        return try StatusOnly.parse(data)
    }

    // POST /v1/approvals/:id/decline  {reason?}
    public func decline(_ link: CardLink, reason: String? = nil, idempotencyKey: String = UUID().uuidString) async throws -> ApprovalStatus {
        var fields: [String: JSONValue] = [:]
        if let reason { fields["reason"] = .string(String(reason.prefix(140))) }
        let data = try await send("POST", "/v1/approvals/\(link.approvalId)/decline", cardToken: link.cardToken, body: CanonicalJSON.data(.object(fields)), idempotencyKey: idempotencyKey)
        return try StatusOnly.parse(data)
    }

    // GET /v1/approvals/:id/status
    public func status(_ link: CardLink) async throws -> ApprovalStatusResponse {
        let data = try await send("GET", "/v1/approvals/\(link.approvalId)/status", cardToken: link.cardToken)
        let response = try ApprovalStatusResponse.parse(data)
        guard response.id == link.approvalId else { throw PennyError.invalidResponse("status id mismatch") }
        return response
    }

    // POST /v1/devices/enroll  {enrollCode, publicKeyEd25519}
    public func enroll(code: String, publicKey: NearPublicKey, idempotencyKey: String = UUID().uuidString) async throws -> EnrollResponse {
        guard EnrollCode.isValid(code) else { throw PennyError.invalidInput("enroll code") }
        let body = CanonicalJSON.data(.object([
            "enrollCode": .string(code),
            "publicKeyEd25519": .string(publicKey.base64URL),
        ]))
        let data = try await send("POST", "/v1/devices/enroll", cardToken: nil, body: body, idempotencyKey: idempotencyKey)
        return try EnrollResponse.parse(data)
    }

    // GET /healthz
    public func health() async -> Bool {
        (try? await send("GET", "/healthz", cardToken: nil)) != nil
    }

    private func send(_ method: String, _ path: String, cardToken: String?, body: Data? = nil, idempotencyKey: String? = nil) async throws -> Data {
        guard baseURL.scheme == "https" || baseURL.host == "localhost" || baseURL.host == "127.0.0.1" else {
            throw PennyError.invalidInput("engine URL must use https")
        }
        // appendingPathComponent keeps any path prefix on the base URL (e.g. https://host/penny).
        let url = baseURL.appendingPathComponent(String(path.dropFirst()))
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let cardToken { request.setValue("Card \(cardToken)", forHTTPHeaderField: "Authorization") }
        if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw PennyError.network
        }
        guard let http = response as? HTTPURLResponse else { throw PennyError.network }
        guard (200..<300).contains(http.statusCode) else { throw PennyError.http(status: http.statusCode) }
        return data
    }
}

/// One-time 8-char code Penny texts the user. Alphabet matches ENROLL_CODE_ALPHABET in packages/shared.
public enum EnrollCode {
    public static let alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789"

    public static func isValid(_ code: String) -> Bool {
        code.count == 8 && code.allSatisfy { alphabet.contains($0) }
    }

    /// Uppercases and drops anything outside the alphabet (spaces, dashes, look-alikes), max 8 chars.
    public static func normalize(_ input: String) -> String {
        String(input.uppercased().filter { alphabet.contains($0) }.prefix(8))
    }
}
