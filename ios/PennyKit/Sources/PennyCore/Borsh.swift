import Foundation

/// Unsigned 128-bit integer, enough for NEAR yoctoNEAR and token base units.
/// Parsed only from canonical decimal strings ("0" or no leading zeros), never from floats.
public struct U128: Equatable, Hashable, Sendable, CustomStringConvertible {
    public let low: UInt64
    public let high: UInt64

    public init(low: UInt64, high: UInt64 = 0) {
        self.low = low
        self.high = high
    }

    public init?(decimal: String) {
        let utf8 = Array(decimal.utf8)
        guard !utf8.isEmpty, utf8.count <= 39, utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else { return nil }
        if utf8.count > 1 && utf8[0] == 48 { return nil }
        var lo: UInt64 = 0
        var hi: UInt64 = 0
        for c in utf8 {
            let digit = UInt64(c - 48)
            // (hi, lo) = (hi, lo) * 10 + digit, failing on overflow.
            let loProduct = lo.multipliedFullWidth(by: 10)
            let (hiTimesTen, o1) = hi.multipliedReportingOverflow(by: 10)
            if o1 { return nil }
            var (newHi, o2) = hiTimesTen.addingReportingOverflow(loProduct.high)
            if o2 { return nil }
            let (newLo, carry) = loProduct.low.addingReportingOverflow(digit)
            if carry {
                let (h, o3) = newHi.addingReportingOverflow(1)
                if o3 { return nil }
                newHi = h
            }
            lo = newLo
            hi = newHi
        }
        self.low = lo
        self.high = hi
    }

    /// Decimal string (for display and round-trip tests).
    public var description: String {
        if high == 0 { return String(low) }
        var hi = high
        var lo = low
        var digits = [UInt8]()
        while hi != 0 || lo != 0 {
            // Divide the 128-bit value by 10.
            let qHi = hi / 10
            let rHi = hi % 10
            let (qLo, rLo) = (10 as UInt64).dividingFullWidth((high: rHi, low: lo))
            hi = qHi
            lo = qLo
            digits.append(UInt8(rLo) + 48)
        }
        return String(decoding: digits.reversed(), as: UTF8.self)
    }
}

/// Minimal Borsh writer (https://borsh.io): little-endian integers, u32-length-prefixed strings and vectors.
public struct BorshWriter {
    public private(set) var bytes: [UInt8] = []

    public init() {}

    public var data: Data { Data(bytes) }

    public mutating func u8(_ v: UInt8) { bytes.append(v) }

    public mutating func u32(_ v: UInt32) {
        withUnsafeBytes(of: v.littleEndian) { bytes.append(contentsOf: $0) }
    }

    public mutating func u64(_ v: UInt64) {
        withUnsafeBytes(of: v.littleEndian) { bytes.append(contentsOf: $0) }
    }

    public mutating func u128(_ v: U128) {
        u64(v.low)
        u64(v.high)
    }

    /// Fixed-size byte array (no length prefix), e.g. [u8; 32].
    public mutating func fixed(_ data: Data) { bytes.append(contentsOf: data) }

    /// Vec<u8>: u32 length + bytes.
    public mutating func byteVector(_ data: Data) {
        u32(UInt32(data.count))
        bytes.append(contentsOf: data)
    }

    /// String: u32 length of the UTF-8 bytes + bytes.
    public mutating func string(_ s: String) {
        let utf8 = Array(s.utf8)
        u32(UInt32(utf8.count))
        bytes.append(contentsOf: utf8)
    }
}
