import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Anything that can sign NEAR delegate-action hashes with an ed25519 key.
/// Production: `DeviceKeyStore` (Keychain + Face ID). Tests and previews: `InMemorySigner`.
public protocol MessageSigner: Sendable {
    func publicKey() throws -> NearPublicKey
    /// Signs `message` (the 32-byte NEP-461 hash). `reason` is shown in the Face ID sheet.
    func sign(_ message: Data, reason: String) async throws -> Data
}

/// Test / preview signer. Never use for real funds.
public struct InMemorySigner: MessageSigner {
    private let key: Curve25519.Signing.PrivateKey

    public init(seed: Data) throws {
        key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
    }

    public init() {
        key = Curve25519.Signing.PrivateKey()
    }

    public func publicKey() throws -> NearPublicKey {
        try NearPublicKey(raw: key.publicKey.rawRepresentation)
    }

    public func sign(_ message: Data, reason: String) async throws -> Data {
        try key.signature(for: message)
    }
}

public enum ApprovalSigning {
    /// Builds the NEP-366 delegate action from the approval fields, hashes it per NEP-461 and signs it.
    /// Refuses expired, non-pending, or other-account approvals before Face ID is ever shown.
    public static func sign(_ approval: Approval, with signer: MessageSigner, expectedAccountId: String?, now: Date = Date()) async throws -> SignedDelegateAction {
        guard approval.status == .pending else { throw PennyError.notPending }
        guard approval.expiresAt > now else { throw PennyError.expired }
        if let expectedAccountId, expectedAccountId != approval.signerId { throw PennyError.wrongAccount }

        let publicKey = try signer.publicKey()
        let delegate = try approval.delegateAction(publicKey: publicKey)
        let signature = try await signer.sign(delegate.signableHash(), reason: approval.faceIDReason)

        // Self-check before anything leaves the phone.
        let verifyKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKey.raw)
        guard verifyKey.isValidSignature(signature, for: delegate.signableHash()) else {
            throw PennyError.invalidInput("signature self-check failed")
        }
        return try SignedDelegateAction(delegateAction: delegate, signature: signature)
    }
}
