#if canImport(LocalAuthentication) && canImport(Security)
import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// The user's NEAR full-access key, generated and kept on this iPhone (ARCHITECTURE.md › Custody model).
///
/// - Private key: 32-byte ed25519 seed (CryptoKit `Curve25519.Signing`) stored as a generic-password item with
///   `SecAccessControl(kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet)`.
///   Not synced, not in backups, unreadable without Face ID, and destroyed by the OS if Face ID enrolment changes.
/// - Public key: stored in a second item without biometry so cards can be rendered without a prompt.
/// - There is no API here that returns the private key. It only ever leaves the Keychain inside `sign`.
///
/// Note: the Secure Enclave does not support ed25519 (NEAR's key type), so the key is software-backed
/// and protected by the Keychain's data-protection class + biometric ACL rather than SE.
public final class DeviceKeyStore: MessageSigner, @unchecked Sendable {
    public static let shared = DeviceKeyStore()

    private let service = "app.penny.device-key"
    private let privateAccount = "ed25519.private"
    private let publicAccount = "ed25519.public"
    private let accessGroup: String?

    /// Shared Keychain group so the host app and the Messages extension see the same key.
    /// Read from Info.plist `PennyKeychainAccessGroup` (= $(AppIdentifierPrefix)app.penny.shared).
    public static var defaultAccessGroup: String? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "PennyKeychainAccessGroup") as? String,
              !group.isEmpty, !group.contains("$(") else { return nil }
        return group
    }

    public init(accessGroup: String? = DeviceKeyStore.defaultAccessGroup) {
        self.accessGroup = accessGroup
    }

    // MARK: Public key

    public var hasKey: Bool { (try? storedPublicKey()) != nil }

    public func publicKey() throws -> NearPublicKey {
        guard let key = try storedPublicKey() else { throw PennyError.noDeviceKey }
        return key
    }

    private func storedPublicKey() throws -> NearPublicKey? {
        var query = baseQuery(account: publicAccount)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw PennyError.keychain(status: status) }
        return try NearPublicKey(raw: data)
    }

    // MARK: Generate

    /// Creates a new key. Fails if one already exists unless `replacing` is true.
    /// Requires a device passcode and enrolled Face ID (the item cannot be created otherwise).
    @discardableResult
    public func generate(replacing: Bool = false) throws -> NearPublicKey {
        let context = LAContext()
        var laError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &laError) else {
            throw PennyError.biometryUnavailable
        }
        if hasKey {
            guard replacing else { return try publicKey() }
            try deleteKey()
        }

        let privateKey = Curve25519.Signing.PrivateKey()
        let publicKey = try NearPublicKey(raw: privateKey.publicKey.rawRepresentation)

        var cfError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            .biometryCurrentSet,
            &cfError
        ) else {
            throw PennyError.keychain(status: errSecParam)
        }

        var privateItem = baseQuery(account: privateAccount)
        privateItem[kSecValueData as String] = privateKey.rawRepresentation
        privateItem[kSecAttrAccessControl as String] = access
        let addPrivate = SecItemAdd(privateItem as CFDictionary, nil)
        guard addPrivate == errSecSuccess else { throw PennyError.keychain(status: addPrivate) }

        var publicItem = baseQuery(account: publicAccount)
        publicItem[kSecValueData as String] = publicKey.raw
        publicItem[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addPublic = SecItemAdd(publicItem as CFDictionary, nil)
        guard addPublic == errSecSuccess else {
            SecItemDelete(baseQuery(account: privateAccount) as CFDictionary)
            throw PennyError.keychain(status: addPublic)
        }
        return publicKey
    }

    // MARK: Sign

    /// Face ID → read the seed with that authenticated context → sign → drop the seed.
    public func sign(_ message: Data, reason: String) async throws -> Data {
        try await signMany([message], reason: reason)[0]
    }

    /// One Face ID for several messages (approval message + signed action). Reading the key
    /// behind `.biometryCurrentSet` is what triggers Face ID; the seed is dropped right after.
    public func signMany(_ messages: [Data], reason: String) async throws -> [Data] {
        let context = LAContext()
        context.localizedReason = reason
        context.localizedCancelTitle = "Not now"
        context.touchIDAuthenticationAllowableReuseDuration = 0

        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
            guard ok else { throw PennyError.userCancelled }
        } catch let error as LAError {
            throw Self.map(error)
        }

        let seed = try await Task.detached(priority: .userInitiated) { [self] in
            try self.readPrivateSeed(context: context)
        }.value

        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        guard key.publicKey.rawRepresentation == (try publicKey()).raw else { throw PennyError.keyInvalidated }
        return try messages.map { try key.signature(for: $0) }
    }

    private func readPrivateSeed(context: LAContext) throws -> Data {
        var query = baseQuery(account: privateAccount)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecUseAuthenticationContext as String] = context
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data, data.count == 32 else { throw PennyError.keychain(status: status) }
            return data
        case errSecItemNotFound:
            // With .biometryCurrentSet the item disappears from reach when Face ID enrolment changes.
            throw hasKey ? PennyError.keyInvalidated : PennyError.noDeviceKey
        case errSecUserCanceled:
            throw PennyError.userCancelled
        case errSecAuthFailed:
            throw PennyError.keyInvalidated
        default:
            throw PennyError.keychain(status: status)
        }
    }

    // MARK: Delete

    /// Removes both items. Only call after the key has been removed on-chain (revoke flow),
    /// otherwise the account loses its only full-access key.
    public func deleteKey() throws {
        for account in [privateAccount, publicAccount] {
            let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw PennyError.keychain(status: status) }
        }
    }

    // MARK: Helpers

    private func baseQuery(account: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    private static func map(_ error: LAError) -> PennyError {
        switch error.code {
        case .userCancel, .appCancel, .systemCancel, .userFallback:
            return .userCancelled
        case .notInteractive:
            return .notInteractive
        case .biometryNotAvailable, .biometryNotEnrolled, .biometryLockout, .passcodeNotSet:
            return .biometryUnavailable
        default:
            return .userCancelled
        }
    }

    /// Whether this device can approve at all (Face ID enrolled + passcode set).
    public static var canUseBiometrics: Bool {
        var error: NSError?
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    }
}
#endif
