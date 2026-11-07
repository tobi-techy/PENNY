import PennyCore
import PennyUI
import SwiftUI

@main
struct PennyHostApp: App {
    @StateObject private var session = HostSession()

    init() {
        PennyFonts.register()
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if session.isEnrolled {
                    HomeView()
                } else {
                    EnrollView()
                }
            }
            .environmentObject(session)
            .preferredColorScheme(.dark)
            .tint(.white)
            .onOpenURL { url in
                // penny://enroll?code=… from Penny's text: no typing needed.
                if let code = EnrollCode.fromLink(url) { session.linkCode = code }
            }
        }
    }
}

/// App-wide state: enrollment, the device key's public half, engine URL.
@MainActor
final class HostSession: ObservableObject {
    /// Enroll code delivered by tapping the link in Penny's text.
    @Published var linkCode: String?
    @Published private(set) var isEnrolled: Bool
    @Published private(set) var accountId: String?
    @Published private(set) var deviceId: String?
    @Published private(set) var publicKey: NearPublicKey?
    @Published private(set) var dryRun: Bool

    private let config = SharedConfig.shared
    private let keys = DeviceKeyStore.shared

    init() {
        isEnrolled = config.isEnrolled && DeviceKeyStore.shared.hasKey
        accountId = config.accountId
        deviceId = config.deviceId
        publicKey = try? DeviceKeyStore.shared.publicKey()
        dryRun = config.enrolledInDryRun
    }

    var engineURL: URL? { config.engineURL }

    func setEngineURL(_ url: URL?) {
        config.setEngineURLOverride(url)
        objectWillChange.send()
    }

    /// Code from Penny's text → new key on this iPhone → POST /v1/devices/enroll.
    func enroll(code: String) async throws {
        guard let baseURL = config.engineURL else { throw PennyError.invalidInput("No engine URL set") }
        guard EnrollCode.isValid(code) else { throw PennyError.invalidInput("That code doesn't look right") }

        // Reuse the key from a failed attempt: the server may already have
        // created the account with it, and enroll answers the same enrollment
        // for the same key. Never delete it here — that would orphan the account.
        var key = try keys.generate(replacing: false)
        let client = EngineClient(baseURL: baseURL)
        let response: EnrollResponse
        do {
            response = try await client.enroll(code: code, publicKey: key)
        } catch PennyError.keyRevoked {
            // The server confirmed this key was revoked (this iPhone was removed
            // from Penny). It did not burn the code, so rotate the local key and
            // retry once with the same code.
            key = try keys.generate(replacing: true)
            response = try await client.enroll(code: code, publicKey: key)
        }
        config.saveEnrollment(response)
        self.publicKey = key
        self.accountId = response.accountId
        self.deviceId = response.deviceId
        self.dryRun = response.status == "dry_run"
        self.isEnrolled = true
    }

    private func client() throws -> EngineClient {
        guard let baseURL = config.engineURL else { throw PennyError.invalidInput("No engine URL set") }
        return EngineClient(baseURL: baseURL)
    }

    /// Remove this iPhone: server revokes the device key, then we wipe locally.
    func removeThisIPhone() async throws {
        guard let accountId, let deviceId else { throw PennyError.invalidInput("This iPhone is not enrolled") }
        try await client().revokeDevice(accountId: accountId, deviceId: deviceId, signer: keys)
        try? keys.deleteKey()
        config.clearEnrollment()
        self.accountId = nil
        self.deviceId = nil
        self.publicKey = nil
        self.isEnrolled = false
    }

    func updateLimits(perTx: String, daily: String, blockNew: String) async throws {
        guard let accountId else { throw PennyError.invalidInput("Not enrolled") }
        try await client().updateGuardPolicy(
            accountId: accountId, perTxUsd: perTx, dailyUsd: daily, blockNewUsd: blockNew, signer: keys)
    }

    func approvalHistory() async throws -> [ApprovalHistoryItem] {
        guard let accountId else { throw PennyError.invalidInput("Not enrolled") }
        return try await client().approvalHistory(accountId: accountId, signer: keys)
    }
}
