import Foundation

// MARK: - Base58 (Bitcoin alphabet, used by NEAR for keys and hashes)

public enum Base58 {
    private static let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".utf8)
    private static let indexes: [Int8] = {
        var table = [Int8](repeating: -1, count: 128)
        for (i, c) in alphabet.enumerated() { table[Int(c)] = Int8(i) }
        return table
    }()

    public static func encode(_ data: Data) -> String {
        let bytes = [UInt8](data)
        var zeros = 0
        while zeros < bytes.count && bytes[zeros] == 0 { zeros += 1 }

        // Base-58 digits, most significant first.
        var digits = [UInt8](repeating: 0, count: (bytes.count - zeros) * 138 / 100 + 1)
        var length = 0
        for byte in bytes[zeros...] {
            var carry = Int(byte)
            var i = 0
            var k = digits.count - 1
            while (carry != 0 || i < length) && k >= 0 {
                carry += 256 * Int(digits[k])
                digits[k] = UInt8(carry % 58)
                carry /= 58
                i += 1
                k -= 1
            }
            length = i
        }
        var start = digits.count - length
        while start < digits.count && digits[start] == 0 { start += 1 }

        var out = [UInt8](repeating: alphabet[0], count: zeros)
        for d in digits[start...] { out.append(alphabet[Int(d)]) }
        return String(decoding: out, as: UTF8.self)
    }

    public static func decode(_ string: String) -> Data? {
        let input = Array(string.utf8)
        var zeros = 0
        while zeros < input.count && input[zeros] == alphabet[0] { zeros += 1 }

        var bytes = [UInt8](repeating: 0, count: (input.count - zeros) * 733 / 1000 + 1)
        var length = 0
        for c in input[zeros...] {
            guard c < 128, indexes[Int(c)] >= 0 else { return nil }
            var carry = Int(indexes[Int(c)])
            var i = 0
            var k = bytes.count - 1
            while (carry != 0 || i < length) && k >= 0 {
                carry += 58 * Int(bytes[k])
                bytes[k] = UInt8(carry % 256)
                carry /= 256
                i += 1
                k -= 1
            }
            length = i
        }
        var start = bytes.count - length
        while start < bytes.count && bytes[start] == 0 { start += 1 }
        return Data([UInt8](repeating: 0, count: zeros) + bytes[start...])
    }
}

// MARK: - Base64 / base64url

extension Data {
    /// Unpadded base64url (RFC 4648 §5).
    public func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Strict unpadded base64url decode. Rejects padding, foreign characters and non-canonical input.
    public init?(base64URLEncoded string: String) {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)
        guard string.utf8.allSatisfy({ allowed.contains($0) }), string.utf8.count % 4 != 1 else { return nil }
        var b64 = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.utf8.count % 4 != 0 { b64.append("=") }
        guard let data = Data(base64Encoded: b64), data.base64URLEncodedString() == string else { return nil }
        self = data
    }

    public var hexString: String { map { String(format: "%02x", $0) }.joined() }

    public init?(hex: String) {
        let chars = Array(hex.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var out = [UInt8]()
        out.reserveCapacity(chars.count / 2)
        func nibble(_ c: UInt8) -> UInt8? {
            switch c {
            case 48...57: return c - 48
            case 97...102: return c - 87
            case 65...70: return c - 55
            default: return nil
            }
        }
        var i = 0
        while i < chars.count {
            guard let hi = nibble(chars[i]), let lo = nibble(chars[i + 1]) else { return nil }
            out.append(hi << 4 | lo)
            i += 2
        }
        self = Data(out)
    }
}
