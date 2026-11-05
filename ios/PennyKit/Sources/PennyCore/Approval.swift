import Foundation

// Mirrors `Approval`, `ApprovalStatusResponse` and `EnrollResponse` in packages/shared/src/schemas.ts.
// Parsing is strict: unknown keys are rejected on money paths, ids and integers are format-checked.

public enum ApprovalKind: String, Sendable, CaseIterable {
    case invest
    case send
    case payBill = "pay_bill"
    case errand
}

public enum ApprovalStatus: String, Sendable {
    case pending, signed, relayed, settled, failed, expired, cancelled

    public var isTerminal: Bool {
        switch self {
        case .settled, .failed, .expired, .cancelled: return true
        case .pending, .signed, .relayed: return false
        }
    }
}

public struct Fact: Equatable, Sendable, Hashable {
    public let label: String
    public let value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

/// An action exactly as the engine describes it. Converted to a `NearAction` for signing.
public enum ApprovalAction: Equatable, Sendable {
    case functionCall(methodName: String, args: [String: JSONValue], gas: String, deposit: String)
    case transfer(deposit: String)

    /// FunctionCall args bytes = UTF-8 of RFC 8785 canonical JSON of the args object.
    /// CONTRACT: the engine must build args bytes the same way, or the byte-for-byte check fails.
    public func nearAction() throws -> NearAction {
        switch self {
        case let .functionCall(methodName, args, gas, deposit):
            guard let gasValue = UInt64(gas), String(gasValue) == gas else { throw PennyError.invalidResponse("gas") }
            guard let depositValue = U128(decimal: deposit) else { throw PennyError.invalidResponse("deposit") }
            return .functionCall(methodName: methodName, args: CanonicalJSON.data(.object(args)), gas: gasValue, deposit: depositValue)
        case let .transfer(deposit):
            guard let depositValue = U128(decimal: deposit) else { throw PennyError.invalidResponse("deposit") }
            return .transfer(deposit: depositValue)
        }
    }

    /// The JSON form used for planHash input ({type, methodName, args, gas, deposit}).
    public var json: JSONValue {
        switch self {
        case let .functionCall(methodName, args, gas, deposit):
            return .object(["type": .string("FunctionCall"), "methodName": .string(methodName), "args": .object(args), "gas": .string(gas), "deposit": .string(deposit)])
        case let .transfer(deposit):
            return .object(["type": .string("Transfer"), "deposit": .string(deposit)])
        }
    }
}

public struct Approval: Equatable, Sendable {
    public let id: String
    public let userId: String
    public let kind: ApprovalKind
    public let title: String
    public let amountDisplay: String
    public let facts: [Fact]
    public let signerId: String
    public let receiverId: String
    public let actions: [ApprovalAction]
    public let nonce: String
    public let maxBlockHeight: String
    public let expiresAt: Date
    public let status: ApprovalStatus
    public let planHash: String

    public init(id: String, userId: String, kind: ApprovalKind, title: String, amountDisplay: String, facts: [Fact],
                signerId: String, receiverId: String, actions: [ApprovalAction], nonce: String, maxBlockHeight: String,
                expiresAt: Date, status: ApprovalStatus, planHash: String) {
        self.id = id
        self.userId = userId
        self.kind = kind
        self.title = title
        self.amountDisplay = amountDisplay
        self.facts = facts
        self.signerId = signerId
        self.receiverId = receiverId
        self.actions = actions
        self.nonce = nonce
        self.maxBlockHeight = maxBlockHeight
        self.expiresAt = expiresAt
        self.status = status
        self.planHash = planHash
    }

    /// Builds the exact NEP-366 DelegateAction the device signs.
    public func delegateAction(publicKey: NearPublicKey) throws -> DelegateAction {
        guard let nonceValue = UInt64(nonce), String(nonceValue) == nonce else { throw PennyError.invalidResponse("nonce") }
        guard let heightValue = UInt64(maxBlockHeight), String(heightValue) == maxBlockHeight else { throw PennyError.invalidResponse("maxBlockHeight") }
        return try DelegateAction(
            senderId: signerId,
            receiverId: receiverId,
            actions: try actions.map { try $0.nearAction() },
            nonce: nonceValue,
            maxBlockHeight: heightValue,
            publicKey: publicKey
        )
    }

    /// Shown in the Face ID sheet, e.g. "Approve $50.00 · Swap · USDC → ETH Momentum".
    public var faceIDReason: String {
        let verb: String
        switch kind {
        case .invest: verb = "Approve"
        case .send: verb = "Send"
        case .payBill: verb = "Pay"
        case .errand: verb = "Hire for"
        }
        return "\(verb) \(amountDisplay) · \(title)"
    }
}

public struct StatusStep: Equatable, Sendable, Hashable {
    public enum State: String, Sendable { case todo, active, done, failed }
    public let label: String
    public let state: State

    public init(label: String, state: State) {
        self.label = label
        self.state = state
    }
}

public struct ApprovalStatusResponse: Equatable, Sendable {
    public let id: String
    public let status: ApprovalStatus
    public let txHash: String?
    public let steps: [StatusStep]
}

public struct EnrollResponse: Equatable, Sendable {
    public let userId: String
    public let accountId: String
    /// "created" or "dry_run"
    public let status: String
}

// MARK: - Strict parsing

enum Validate {
    static let crockford = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ".utf8)

    static func ulid(_ s: String, prefix: String) -> Bool {
        guard s.hasPrefix(prefix) else { return false }
        let body = s.utf8.dropFirst(prefix.utf8.count)
        return body.count == 26 && body.allSatisfy { crockford.contains($0) }
    }

    static func approvalId(_ s: String) -> Bool { ulid(s, prefix: "apr_") }
    static func userId(_ s: String) -> Bool { ulid(s, prefix: "usr_") }

    static func u64(_ s: String) -> Bool {
        guard let v = UInt64(s) else { return false }
        return String(v) == s
    }

    static func u128(_ s: String) -> Bool { U128(decimal: s) != nil }

    static func base64URL(_ s: String, length: Int? = nil) -> Bool {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)
        if let length, s.utf8.count != length { return false }
        return !s.isEmpty && s.utf8.allSatisfy { allowed.contains($0) }
    }

    /// cardToken: 32 random bytes; accept any base64url/hex style token of sane length.
    static func cardToken(_ s: String) -> Bool { base64URL(s) && s.utf8.count >= 32 && s.utf8.count <= 128 }

    static func date(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}

/// Reads one JSON object and refuses unknown keys.
struct StrictObject {
    let fields: [String: JSONValue]
    let context: String

    init(_ value: JSONValue?, context: String, allowed: Set<String>) throws {
        guard let object = value?.objectValue else { throw PennyError.invalidResponse("\(context) is not an object") }
        let unknown = Set(object.keys).subtracting(allowed)
        guard unknown.isEmpty else { throw PennyError.invalidResponse("\(context) has unknown keys") }
        self.fields = object
        self.context = context
    }

    func string(_ key: String, maxLength: Int = 4096) throws -> String {
        guard let s = fields[key]?.stringValue, s.count <= maxLength else { throw PennyError.invalidResponse("\(context).\(key)") }
        return s
    }

    func optionalString(_ key: String) throws -> String? {
        guard let v = fields[key] else { return nil }
        if v == .null { return nil }
        guard let s = v.stringValue else { throw PennyError.invalidResponse("\(context).\(key)") }
        return s
    }

    func array(_ key: String) throws -> [JSONValue] {
        guard let a = fields[key]?.arrayValue else { throw PennyError.invalidResponse("\(context).\(key)") }
        return a
    }
}

extension Approval {
    static let keys: Set<String> = ["id", "userId", "kind", "title", "amountDisplay", "facts", "signerId", "receiverId",
                                    "actions", "nonce", "maxBlockHeight", "expiresAt", "status", "planHash"]

    public static func parse(_ data: Data) throws -> Approval {
        try parse(JSONParser.parse(data))
    }

    public static func parse(_ json: JSONValue) throws -> Approval {
        let o = try StrictObject(json, context: "approval", allowed: keys)

        let id = try o.string("id")
        guard Validate.approvalId(id) else { throw PennyError.invalidResponse("approval.id") }
        let userId = try o.string("userId")
        guard Validate.userId(userId) else { throw PennyError.invalidResponse("approval.userId") }
        guard let kind = ApprovalKind(rawValue: try o.string("kind")) else { throw PennyError.invalidResponse("approval.kind") }
        let title = try o.string("title", maxLength: 80)
        let amountDisplay = try o.string("amountDisplay", maxLength: 40)

        let factsJSON = try o.array("facts")
        guard factsJSON.count <= 8 else { throw PennyError.invalidResponse("approval.facts") }
        let facts = try factsJSON.map { item -> Fact in
            let f = try StrictObject(item, context: "fact", allowed: ["label", "value"])
            return Fact(label: try f.string("label", maxLength: 40), value: try f.string("value", maxLength: 80))
        }

        let signerId = try o.string("signerId")
        let receiverId = try o.string("receiverId")
        guard NearAccountID.isValid(signerId), NearAccountID.isValid(receiverId) else { throw PennyError.invalidResponse("approval account ids") }

        let actionsJSON = try o.array("actions")
        guard (1...8).contains(actionsJSON.count) else { throw PennyError.invalidResponse("approval.actions") }
        let actions = try actionsJSON.map(parseAction)

        let nonce = try o.string("nonce")
        let maxBlockHeight = try o.string("maxBlockHeight")
        guard Validate.u64(nonce), Validate.u64(maxBlockHeight) else { throw PennyError.invalidResponse("approval nonce/height") }

        guard let expiresAt = Validate.date(try o.string("expiresAt")) else { throw PennyError.invalidResponse("approval.expiresAt") }
        guard let status = ApprovalStatus(rawValue: try o.string("status")) else { throw PennyError.invalidResponse("approval.status") }
        let planHash = try o.string("planHash")
        guard Validate.base64URL(planHash, length: 43) else { throw PennyError.invalidResponse("approval.planHash") }

        return Approval(id: id, userId: userId, kind: kind, title: title, amountDisplay: amountDisplay, facts: facts,
                        signerId: signerId, receiverId: receiverId, actions: actions, nonce: nonce,
                        maxBlockHeight: maxBlockHeight, expiresAt: expiresAt, status: status, planHash: planHash)
    }

    static func parseAction(_ json: JSONValue) throws -> ApprovalAction {
        guard let type = json["type"]?.stringValue else { throw PennyError.invalidResponse("action.type") }
        switch type {
        case "FunctionCall":
            let a = try StrictObject(json, context: "action", allowed: ["type", "methodName", "args", "gas", "deposit"])
            let method = try a.string("methodName", maxLength: 256)
            guard !method.isEmpty, let args = a.fields["args"]?.objectValue else { throw PennyError.invalidResponse("action.args") }
            let gas = try a.string("gas")
            let deposit = try a.string("deposit")
            guard Validate.u64(gas), Validate.u128(deposit) else { throw PennyError.invalidResponse("action gas/deposit") }
            return .functionCall(methodName: method, args: args, gas: gas, deposit: deposit)
        case "Transfer":
            let a = try StrictObject(json, context: "action", allowed: ["type", "deposit"])
            let deposit = try a.string("deposit")
            guard Validate.u128(deposit) else { throw PennyError.invalidResponse("action.deposit") }
            return .transfer(deposit: deposit)
        default:
            // Only FunctionCall and Transfer may ever be signed from a card.
            throw PennyError.invalidResponse("action type not allowed")
        }
    }
}

extension ApprovalStatusResponse {
    public static func parse(_ data: Data) throws -> ApprovalStatusResponse {
        let o = try StrictObject(try JSONParser.parse(data), context: "status", allowed: ["id", "status", "txHash", "steps"])
        let id = try o.string("id")
        guard Validate.approvalId(id) else { throw PennyError.invalidResponse("status.id") }
        guard let status = ApprovalStatus(rawValue: try o.string("status")) else { throw PennyError.invalidResponse("status.status") }
        let txHash = try o.optionalString("txHash")
        let steps = try o.array("steps").map { item -> StatusStep in
            let s = try StrictObject(item, context: "step", allowed: ["label", "state"])
            guard let state = StatusStep.State(rawValue: try s.string("state")) else { throw PennyError.invalidResponse("step.state") }
            return StatusStep(label: try s.string("label", maxLength: 120), state: state)
        }
        return ApprovalStatusResponse(id: id, status: status, txHash: txHash, steps: steps)
    }
}

extension EnrollResponse {
    public static func parse(_ data: Data) throws -> EnrollResponse {
        let o = try StrictObject(try JSONParser.parse(data), context: "enroll", allowed: ["userId", "accountId", "status"])
        let userId = try o.string("userId")
        let accountId = try o.string("accountId")
        let status = try o.string("status")
        guard Validate.userId(userId), NearAccountID.isValid(accountId), ["created", "dry_run"].contains(status) else {
            throw PennyError.invalidResponse("enroll")
        }
        return EnrollResponse(userId: userId, accountId: accountId, status: status)
    }
}

/// Small status body ({status}) returned by submit and decline. Extra keys tolerated here (no money decision rides on them).
enum StatusOnly {
    static func parse(_ data: Data) throws -> ApprovalStatus {
        guard let raw = try JSONParser.parse(data)["status"]?.stringValue, let status = ApprovalStatus(rawValue: raw) else {
            throw PennyError.invalidResponse("status")
        }
        return status
    }
}
