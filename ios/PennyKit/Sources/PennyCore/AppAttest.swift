import Foundation
#if canImport(DeviceCheck)
import DeviceCheck
#endif
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// App Attest (DeviceCheck): one attestation key per install, attested once
/// at enroll against a server challenge, then cheap assertions per
/// device-signed request. The engine verifies attestation against Apple's
/// root CA and assertions with a monotonic counter — a blob alone is never
/// trusted. Unavailable on Simulator/Mac (isSupported == false); enroll then
/// proceeds without it in dev and is refused on mainnet by the engine.
public final class AppAttestManager: @unchecked Sendable {
    public static let shared = AppAttestManager()

    private let defaults: UserDefaults
    private static let keyIdKey = "penny.appAttestKeyId"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var isSupported: Bool {
        #if canImport(DeviceCheck)
        return DCAppAttestService.shared.isSupported
        #else
        return false
        #endif
    }

    public var keyId: String? { defaults.string(forKey: Self.keyIdKey) }

    /// Generate (once) and attest a key against the server challenge.
    /// Returns base64url attestation object for EnrollBody.appAttest.
    public func attest(challengeB64: String) async throws -> String {
        #if canImport(DeviceCheck)
        let service = DCAppAttestService.shared
        guard service.isSupported else { throw PennyError.invalidInput("App Attest not supported on this device") }
        let keyId: String
        if let existing = self.keyId {
            keyId = existing
        } else {
            keyId = try await service.generateKey()
            defaults.set(keyId, forKey: Self.keyIdKey)
        }
        guard let challenge = Data(base64URLEncoded: challengeB64) else {
            throw PennyError.invalidInput("bad attest challenge")
        }
        let clientDataHash = Data(SHA256.hash(data: challenge))
        let attestation = try await service.attestKey(keyId, clientDataHash: clientDataHash)
        return attestation.base64URLEncodedString()
        #else
        throw PennyError.invalidInput("App Attest unavailable")
        #endif
    }

    /// Assertion over a device-signed message (clientDataHash = SHA256(message)).
    /// Returns nil when no attested key exists (dev without attestation).
    public func assertion(for message: String) async -> String? {
        #if canImport(DeviceCheck)
        let service = DCAppAttestService.shared
        guard service.isSupported, let keyId else { return nil }
        let clientDataHash = Data(SHA256.hash(data: Data(message.utf8)))
        let assertion = try? await service.generateAssertion(keyId, clientDataHash: clientDataHash)
        return assertion?.base64URLEncodedString()
        #else
        return nil
        #endif
    }

    public func reset() {
        defaults.removeObject(forKey: Self.keyIdKey)
    }
}
