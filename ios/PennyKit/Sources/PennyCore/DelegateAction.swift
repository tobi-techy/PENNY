import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// NEAR account id rules (nomicon): 2...64 chars, lowercase a-z 0-9, parts split by "." and
/// separators "-" / "_" only between alphanumerics. Mirrors NearAccountId in packages/shared.
public enum NearAccountID {
    public static func isValid(_ id: String) -> Bool {
        let bytes = Array(id.utf8)
        guard bytes.count >= 2, bytes.count <= 64 else { return false }
        func isAlnum(_ c: UInt8) -> Bool { (c >= 97 && c <= 122) || (c >= 48 && c <= 57) }
        var previous: UInt8? = nil
        for c in bytes {
            let isSeparator = c == 46 || c == 45 || c == 95 // . - _
            guard isAlnum(c) || isSeparator else { return false }
            if isSeparator {
                guard let p = previous, isAlnum(p) else { return false }
            }
            previous = c
        }
        guard let first = bytes.first, let last = bytes.last else { return false }
        return isAlnum(first) && isAlnum(last)
    }
}

/// ed25519 public key as NEAR expects it.
public struct NearPublicKey: Equatable, Hashable, Sendable {
    public let raw: Data

    public init(raw: Data) throws {
        guard raw.count == 32 else { throw PennyError.invalidInput("ed25519 public key must be 32 bytes") }
        self.raw = raw
    }

    /// "ed25519:<base58>", the form NEAR RPC and explorers show.
    public var nearString: String { "ed25519:" + Base58.encode(raw) }

    /// Unpadded base64url of the 32 raw bytes (what POST /v1/devices/enroll takes).
    public var base64URL: String { raw.base64URLEncodedString() }

    func write(to w: inout BorshWriter) {
        w.u8(0) // KeyType::ED25519
        w.fixed(raw)
    }
}

/// The two NEAR actions Penny cards may sign. Anything else is rejected when parsing an Approval.
public enum NearAction: Equatable, Sendable {
    case functionCall(methodName: String, args: Data, gas: UInt64, deposit: U128)
    case transfer(deposit: U128)

    // Borsh enum tags from nearcore core/primitives/src/action/mod.rs:
    // CreateAccount=0, DeployContract=1, FunctionCall=2, Transfer=3, ... Delegate=8.
    func write(to w: inout BorshWriter) {
        switch self {
        case let .functionCall(methodName, args, gas, deposit):
            w.u8(2)
            w.string(methodName)
            w.byteVector(args)
            w.u64(gas)
            w.u128(deposit)
        case let .transfer(deposit):
            w.u8(3)
            w.u128(deposit)
        }
    }
}

/// NEP-366 DelegateAction (meta transaction body).
/// Field order per https://github.com/near/NEPs/blob/master/neps/nep-0366.md
public struct DelegateAction: Equatable, Sendable {
    public let senderId: String
    public let receiverId: String
    public let actions: [NearAction]
    public let nonce: UInt64
    public let maxBlockHeight: UInt64
    public let publicKey: NearPublicKey

    /// NEP-461 signable-message discriminant for NEP-366 delegate actions: 2^30 + 366 = 1073742190.
    /// Source: nearcore core/primitives/src/signable_message.rs
    /// (MIN_ON_CHAIN_DISCRIMINANT = 1 << 30, NEP_366_META_TRANSACTIONS = 366, borsh u32 little-endian).
    public static let nep461Prefix: UInt32 = (1 << 30) + 366

    public init(senderId: String, receiverId: String, actions: [NearAction], nonce: UInt64, maxBlockHeight: UInt64, publicKey: NearPublicKey) throws {
        guard NearAccountID.isValid(senderId) else { throw PennyError.invalidInput("bad sender account id") }
        guard NearAccountID.isValid(receiverId) else { throw PennyError.invalidInput("bad receiver account id") }
        guard !actions.isEmpty else { throw PennyError.invalidInput("delegate action needs at least one action") }
        self.senderId = senderId
        self.receiverId = receiverId
        self.actions = actions
        self.nonce = nonce
        self.maxBlockHeight = maxBlockHeight
        self.publicKey = publicKey
    }

    func write(to w: inout BorshWriter) {
        w.string(senderId)
        w.string(receiverId)
        w.u32(UInt32(actions.count))
        for action in actions { action.write(to: &w) }
        w.u64(nonce)
        w.u64(maxBlockHeight)
        publicKey.write(to: &w)
    }

    /// borsh(DelegateAction)
    public func borsh() -> Data {
        var w = BorshWriter()
        write(to: &w)
        return w.data
    }

    /// borsh(u32 prefix) ++ borsh(DelegateAction): the bytes that get hashed.
    public func signableMessage() -> Data {
        var w = BorshWriter()
        w.u32(Self.nep461Prefix)
        write(to: &w)
        return w.data
    }

    /// sha256(signableMessage). The ed25519 signature is over these 32 bytes.
    public func signableHash() -> Data {
        Data(SHA256.hash(data: signableMessage()))
    }
}

/// NEP-366 SignedDelegateAction.
public struct SignedDelegateAction: Equatable, Sendable {
    public let delegateAction: DelegateAction
    public let signature: Data

    public init(delegateAction: DelegateAction, signature: Data) throws {
        guard signature.count == 64 else { throw PennyError.invalidInput("ed25519 signature must be 64 bytes") }
        self.delegateAction = delegateAction
        self.signature = signature
    }

    public func borsh() -> Data {
        var w = BorshWriter()
        delegateAction.write(to: &w)
        w.u8(0) // KeyType::ED25519
        w.fixed(signature)
        return w.data
    }

    /// Standard padded base64 of the borsh bytes (POST /v1/approvals/:id/submit body).
    public var base64: String { borsh().base64EncodedString() }
}
