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
        }
    }
}

/// App-wide state: enrollment, the device key's public half, engine URL.
@MainActor
final class HostSession: ObservableObject {
    @Published private(set) var isEnrolled: Bool
    @Published private(set) var accountId: String?
    @Published private(set) var publicKey: NearPublicKey?
    @Published private(set) var dryRun: Bool

    private let config = SharedConfig.shared
    private let keys = DeviceKeyStore.shared

    init() {
        isEnrolled = config.isEnrolled && DeviceKeyStore.shared.hasKey
        accountId = config.accountId
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

        // A key without an account means a previous attempt failed; replacing it is safe.
        let hadAccount = config.isEnrolled
        let publicKey = try keys.generate(replacing: !hadAccount)
        do {
            let response = try await EngineClient(baseURL: baseURL).enroll(code: code, publicKey: publicKey)
            config.saveEnrollment(response)
            self.publicKey = publicKey
            self.accountId = response.accountId
            self.dryRun = response.status == "dry_run"
            self.isEnrolled = true
        } catch {
            // The server never saw this key as an account key, so don't leave it lying around.
            if !hadAccount { try? keys.deleteKey() }
            throw error
        }
    }
}
