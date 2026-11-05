import Foundation

/// Non-secret settings shared by the host app and the Messages extension through the App Group.
/// Nothing secret lives here: the key is in the Keychain, card tokens are never stored.
public struct SharedConfig {
    public static let shared = SharedConfig()

    private let defaults: UserDefaults

    /// App Group id from Info.plist `PennyAppGroup` (= group.app.penny.host).
    public static var appGroup: String? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "PennyAppGroup") as? String,
              !group.isEmpty, !group.contains("$(") else { return nil }
        return group
    }

    public init(defaults: UserDefaults? = nil) {
        if let defaults {
            self.defaults = defaults
        } else if let group = SharedConfig.appGroup, let groupDefaults = UserDefaults(suiteName: group) {
            self.defaults = groupDefaults
        } else {
            self.defaults = .standard
        }
    }

    private enum Key {
        static let engineURL = "penny.engineURL"
        static let accountId = "penny.accountId"
        static let userId = "penny.userId"
        static let enrolledAt = "penny.enrolledAt"
        static let dryRun = "penny.enrollDryRun"
    }

    /// Engine base URL. Override (set in the host app's Settings, debug builds) wins over Info.plist `PennyEngineURL`.
    public var engineURL: URL? {
        if let s = defaults.string(forKey: Key.engineURL), let url = URL(string: s) { return url }
        if let s = Bundle.main.object(forInfoDictionaryKey: "PennyEngineURL") as? String,
           !s.isEmpty, !s.contains("$("), let url = URL(string: s) { return url }
        return nil
    }

    public func setEngineURLOverride(_ url: URL?) {
        defaults.set(url?.absoluteString, forKey: Key.engineURL)
    }

    public var accountId: String? { defaults.string(forKey: Key.accountId) }
    public var userId: String? { defaults.string(forKey: Key.userId) }
    public var enrolledAt: Date? { defaults.object(forKey: Key.enrolledAt) as? Date }
    public var enrolledInDryRun: Bool { defaults.bool(forKey: Key.dryRun) }
    public var isEnrolled: Bool { accountId != nil }

    public func saveEnrollment(_ response: EnrollResponse, at date: Date = Date()) {
        defaults.set(response.accountId, forKey: Key.accountId)
        defaults.set(response.userId, forKey: Key.userId)
        defaults.set(date, forKey: Key.enrolledAt)
        defaults.set(response.status == "dry_run", forKey: Key.dryRun)
    }

    public func clearEnrollment() {
        for key in [Key.accountId, Key.userId, Key.enrolledAt, Key.dryRun] { defaults.removeObject(forKey: key) }
    }
}
