import Foundation

public enum PennyError: Error, Equatable, LocalizedError {
    case invalidInput(String)
    case invalidResponse(String)
    case http(status: Int)
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

    /// Plain words for the card. Never includes tokens, keys or request bodies.
    public var errorDescription: String? {
        switch self {
        case .invalidInput: return "Something in this request looks wrong."
        case .invalidResponse: return "Penny sent something this card can't read."
        case let .http(status) where status == 401 || status == 403: return "This card link has expired. Ask Penny again."
        case let .http(status) where status == 404: return "Penny can't find this request anymore."
        case let .http(status) where status == 409: return "This request was already handled."
        case .http: return "Penny's server had a problem. Try again in a moment."
        case .network: return "No connection. Try again when you're online."
        case .expired: return "The quote expired. Ask Penny for a fresh one."
        case .notPending: return "This request was already handled."
        case .wrongAccount: return "This card is for a different Penny account."
        case .noDeviceKey: return "This iPhone isn't linked to Penny yet. Open the Penny app to link it."
        case .keyInvalidated: return "Face ID changed on this iPhone, so the Penny key was locked. Re-link in the Penny app."
        case .keychain: return "The secure key store didn't respond. Try again."
        case .biometryUnavailable: return "Face ID is off or locked. Turn it on in Settings to approve."
        case .notInteractive: return "Open the card to approve with Face ID."
        case .userCancelled: return "Cancelled. Nothing was sent."
        }
    }
}
