import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// RFC 8785 JSON Canonicalization Scheme (JCS), matching packages/shared/src/canonical.ts:
///  - object keys sorted by UTF-16 code units,
///  - strings escaped like ECMAScript JSON.stringify,
///  - numbers formatted like ECMAScript Number.prototype.toString,
///  - no whitespace.
public enum CanonicalJSON {
    public static func string(_ value: JSONValue) -> String {
        var out = ""
        write(value, into: &out)
        return out
    }

    public static func data(_ value: JSONValue) -> Data {
        Data(string(value).utf8)
    }

    /// Parse JSON text, then canonicalize. Throws on anything that is not I-JSON.
    public static func canonicalize(_ text: String) throws -> String {
        string(try JSONParser.parse(text))
    }

    /// base64url(sha256(canonical JSON)), the planHash format.
    public static func sha256Base64URL(_ value: JSONValue) -> String {
        Data(SHA256.hash(data: data(value))).base64URLEncodedString()
    }

    private static func write(_ value: JSONValue, into out: inout String) {
        switch value {
        case .null: out += "null"
        case let .bool(b): out += b ? "true" : "false"
        case let .number(n): out += ecmaScriptNumber(n)
        case let .string(s): writeString(s, into: &out)
        case let .array(items):
            out += "["
            for (idx, item) in items.enumerated() {
                if idx > 0 { out += "," }
                write(item, into: &out)
            }
            out += "]"
        case let .object(members):
            out += "{"
            let keys = members.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
            for (idx, key) in keys.enumerated() {
                if idx > 0 { out += "," }
                writeString(key, into: &out)
                out += ":"
                write(members[key]!, into: &out)
            }
            out += "}"
        }
    }

    private static func writeString(_ s: String, into out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar.value {
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x08: out += "\\b"
            case 0x0C: out += "\\f"
            case 0x0A: out += "\\n"
            case 0x0D: out += "\\r"
            case 0x09: out += "\\t"
            case 0x00..<0x20:
                let hex = String(scalar.value, radix: 16)
                out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
            default:
                out.unicodeScalars.append(scalar)
            }
        }
        out += "\""
    }

    /// ECMAScript Number::toString(x) for finite doubles (ECMA-262 §6.1.6.1.20).
    /// Swift's `description` already yields the shortest round-trip digits; we only re-layout them.
    public static func ecmaScriptNumber(_ x: Double) -> String {
        precondition(x.isFinite, "non-finite numbers are not I-JSON")
        if x == 0 { return "0" } // also covers -0
        if x < 0 { return "-" + ecmaScriptNumber(-x) }

        // Swift forms: "123.0", "0.001", "1e-07", "1.5e+300", "5e-324".
        let text = x.description
        let parts = text.split(separator: "e", maxSplits: 1)
        let mantissa = String(parts[0])
        let exponent = parts.count > 1 ? Int(parts[1])! : 0
        let mParts = mantissa.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        let intPart = String(mParts[0])
        let fracPart = mParts.count > 1 ? String(mParts[1]) : ""

        var digits = Array(intPart + fracPart)
        var pointPosition = intPart.count + exponent // decimal point sits after this many digits
        while digits.first == "0" {
            digits.removeFirst()
            pointPosition -= 1
        }
        while digits.last == "0" { digits.removeLast() }

        let k = digits.count
        let n = pointPosition
        let s = String(digits)

        if k <= n && n <= 21 {
            return s + String(repeating: "0", count: n - k)
        }
        if 0 < n && n <= 21 {
            return String(digits[0..<n]) + "." + String(digits[n...])
        }
        if -6 < n && n <= 0 {
            return "0." + String(repeating: "0", count: -n) + s
        }
        let e = n - 1
        let expText = (e >= 0 ? "+" : "-") + String(abs(e))
        if k == 1 {
            return s + "e" + expText
        }
        return String(digits[0]) + "." + String(digits[1...]) + "e" + expText
    }
}
