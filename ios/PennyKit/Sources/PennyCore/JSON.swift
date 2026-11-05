import Foundation

/// A parsed JSON value. Numbers are IEEE-754 doubles, exactly like JavaScript, so canonical
/// encoding matches the engine's TypeScript implementation. Money never travels as a JSON number.
public indirect enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public var stringValue: String? {
        if case let .string(s) = self { return s }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case let .object(o) = self { return o }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case let .array(a) = self { return a }
        return nil
    }

    public subscript(key: String) -> JSONValue? { objectValue?[key] }
}

public struct JSONParseError: Error, Equatable, CustomStringConvertible {
    public let message: String
    public let offset: Int
    public var description: String { "JSON parse error at \(offset): \(message)" }
}

/// Strict RFC 8259 / I-JSON parser:
/// rejects lone surrogates, duplicate object keys, non-finite numbers, trailing data and nesting deeper than 64.
public struct JSONParser {
    private let bytes: [UInt8]
    private var i = 0

    public static func parse(_ data: Data) throws -> JSONValue {
        var p = JSONParser(bytes: [UInt8](data))
        return try p.parseDocument()
    }

    public static func parse(_ text: String) throws -> JSONValue {
        try parse(Data(text.utf8))
    }

    private init(bytes: [UInt8]) { self.bytes = bytes }

    private func fail(_ message: String) -> JSONParseError { JSONParseError(message: message, offset: i) }

    private mutating func parseDocument() throws -> JSONValue {
        // Tolerate a UTF-8 BOM.
        if bytes.count >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF { i = 3 }
        skipWhitespace()
        let value = try parseValue(depth: 0)
        skipWhitespace()
        guard i == bytes.count else { throw fail("trailing data") }
        return value
    }

    private mutating func skipWhitespace() {
        while i < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[i]) { i += 1 }
    }

    private mutating func parseValue(depth: Int) throws -> JSONValue {
        guard depth <= 64 else { throw fail("nesting too deep") }
        guard i < bytes.count else { throw fail("unexpected end") }
        switch bytes[i] {
        case UInt8(ascii: "{"): return try parseObject(depth: depth)
        case UInt8(ascii: "["): return try parseArray(depth: depth)
        case UInt8(ascii: "\""): return .string(try parseString())
        case UInt8(ascii: "t"): try expectLiteral("true"); return .bool(true)
        case UInt8(ascii: "f"): try expectLiteral("false"); return .bool(false)
        case UInt8(ascii: "n"): try expectLiteral("null"); return .null
        default: return .number(try parseNumber())
        }
    }

    private mutating func expectLiteral(_ literal: String) throws {
        let lit = Array(literal.utf8)
        guard i + lit.count <= bytes.count, Array(bytes[i..<(i + lit.count)]) == lit else { throw fail("invalid literal") }
        i += lit.count
    }

    private mutating func parseObject(depth: Int) throws -> JSONValue {
        i += 1
        var object: [String: JSONValue] = [:]
        skipWhitespace()
        if i < bytes.count && bytes[i] == UInt8(ascii: "}") { i += 1; return .object(object) }
        while true {
            skipWhitespace()
            guard i < bytes.count, bytes[i] == UInt8(ascii: "\"") else { throw fail("expected object key") }
            let key = try parseString()
            guard object[key] == nil else { throw fail("duplicate key \"\(key)\"") }
            skipWhitespace()
            guard i < bytes.count, bytes[i] == UInt8(ascii: ":") else { throw fail("expected ':'") }
            i += 1
            skipWhitespace()
            object[key] = try parseValue(depth: depth + 1)
            skipWhitespace()
            guard i < bytes.count else { throw fail("unterminated object") }
            if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
            if bytes[i] == UInt8(ascii: "}") { i += 1; return .object(object) }
            throw fail("expected ',' or '}'")
        }
    }

    private mutating func parseArray(depth: Int) throws -> JSONValue {
        i += 1
        var array: [JSONValue] = []
        skipWhitespace()
        if i < bytes.count && bytes[i] == UInt8(ascii: "]") { i += 1; return .array(array) }
        while true {
            skipWhitespace()
            array.append(try parseValue(depth: depth + 1))
            skipWhitespace()
            guard i < bytes.count else { throw fail("unterminated array") }
            if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
            if bytes[i] == UInt8(ascii: "]") { i += 1; return .array(array) }
            throw fail("expected ',' or ']'")
        }
    }

    private mutating func parseHex4() throws -> UInt16 {
        guard i + 4 <= bytes.count else { throw fail("short \\u escape") }
        var v: UInt16 = 0
        for _ in 0..<4 {
            let c = bytes[i]
            let n: UInt16
            switch c {
            case 48...57: n = UInt16(c - 48)
            case 97...102: n = UInt16(c - 87)
            case 65...70: n = UInt16(c - 55)
            default: throw fail("bad hex digit")
            }
            v = v << 4 | n
            i += 1
        }
        return v
    }

    private mutating func parseString() throws -> String {
        i += 1 // opening quote
        var units: [UInt16] = []
        var rawRun: [UInt8] = []

        func flushRaw() throws {
            guard !rawRun.isEmpty else { return }
            guard let s = String(bytes: rawRun, encoding: .utf8) else { throw fail("invalid UTF-8") }
            units.append(contentsOf: s.utf16)
            rawRun.removeAll(keepingCapacity: true)
        }

        while true {
            guard i < bytes.count else { throw fail("unterminated string") }
            let c = bytes[i]
            if c == UInt8(ascii: "\"") {
                i += 1
                break
            }
            if c < 0x20 { throw fail("unescaped control character") }
            if c == UInt8(ascii: "\\") {
                try flushRaw()
                i += 1
                guard i < bytes.count else { throw fail("bad escape") }
                let e = bytes[i]
                i += 1
                switch e {
                case UInt8(ascii: "\""): units.append(0x22)
                case UInt8(ascii: "\\"): units.append(0x5C)
                case UInt8(ascii: "/"): units.append(0x2F)
                case UInt8(ascii: "b"): units.append(0x08)
                case UInt8(ascii: "f"): units.append(0x0C)
                case UInt8(ascii: "n"): units.append(0x0A)
                case UInt8(ascii: "r"): units.append(0x0D)
                case UInt8(ascii: "t"): units.append(0x09)
                case UInt8(ascii: "u"): units.append(try parseHex4())
                default: throw fail("bad escape")
                }
                continue
            }
            rawRun.append(c)
            i += 1
        }
        try flushRaw()

        // Reject lone surrogates (not I-JSON); Swift would silently replace them with U+FFFD.
        var k = 0
        while k < units.count {
            let u = units[k]
            if u >= 0xD800 && u <= 0xDBFF {
                guard k + 1 < units.count, units[k + 1] >= 0xDC00, units[k + 1] <= 0xDFFF else { throw fail("lone surrogate") }
                k += 2
            } else if u >= 0xDC00 && u <= 0xDFFF {
                throw fail("lone surrogate")
            } else {
                k += 1
            }
        }
        return String(decoding: units, as: UTF16.self)
    }

    private mutating func parseNumber() throws -> Double {
        let start = i
        if i < bytes.count && bytes[i] == UInt8(ascii: "-") { i += 1 }
        func isDigit(_ c: UInt8) -> Bool { c >= 48 && c <= 57 }
        guard i < bytes.count, isDigit(bytes[i]) else { throw fail("invalid value") }
        if bytes[i] == 48 {
            i += 1
        } else {
            while i < bytes.count && isDigit(bytes[i]) { i += 1 }
        }
        if i < bytes.count && bytes[i] == UInt8(ascii: ".") {
            i += 1
            guard i < bytes.count, isDigit(bytes[i]) else { throw fail("invalid fraction") }
            while i < bytes.count && isDigit(bytes[i]) { i += 1 }
        }
        if i < bytes.count && (bytes[i] == UInt8(ascii: "e") || bytes[i] == UInt8(ascii: "E")) {
            i += 1
            if i < bytes.count && (bytes[i] == UInt8(ascii: "+") || bytes[i] == UInt8(ascii: "-")) { i += 1 }
            guard i < bytes.count, isDigit(bytes[i]) else { throw fail("invalid exponent") }
            while i < bytes.count && isDigit(bytes[i]) { i += 1 }
        }
        let text = String(decoding: bytes[start..<i], as: UTF8.self)
        guard let value = Double(text), value.isFinite else { throw fail("number out of range") }
        return value
    }
}
