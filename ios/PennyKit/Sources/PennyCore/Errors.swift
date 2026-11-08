import Foundation

public enum PennyError: Error, Equatable, LocalizedError {
    case invalidInput(String)
    case invalidResponse(String)
    case http(status: Int)
    case keyRevoked
    case network
    case expired
    case notPending
    case wrongAccount
    case noDeviceKey
    case keyInvalidated
    case keychain(status: Int32)
    case biometryUnavailable
    case notInteractive
    case userCancelled
    case frozen

    /// Plain words for the card. Never includes tokens, keys or request bodies.
    public var errorDescription: String? {
        switch self {
        case .invalidInput: return "Something in this request looks wrong."
        case .invalidResponse: return "Penny sent something this card can't read."
        case let .http(status) where status == 401 || status == 403: return "This card link has expired. Ask Penny again."
        case let .http(status) where status == 404: return "Penny can't find this request anymore."
        case let .http(status) where status == 409: return "This request was already handled."
        case .http: return "Penny's server had a problem. Try again in a moment."
        case .keyRevoked: return "This iPhone was removed from Penny. Link it again with a new code."
        case .network: return "No connection. Try again when you're online."
        case .expired: return "This card ran out of time. Tap Get a new card."
        case .notPending: return "This request was already handled."
        case .wrongAccount: return "This card is for a different Penny account."
        case .noDeviceKey: return "This iPhone isn't linked to Penny yet. Open the Penny app to link it."
        case .keyInvalidated: return "Face ID changed on this iPhone, so the Penny key was locked. Re-link in the Penny app."
        case .keychain: return "The secure key store didn't respond. Try again."
        case .biometryUnavailable: return "Face ID is off or locked. Turn it on in Settings to approve."
        case .notInteractive: return "Open the card to approve with Face ID."
        case .userCancelled: return "Cancelled. Nothing was sent."
        case .frozen: return "Penny is frozen. Text unfreeze to start again."
        }
    }
}
