import PennyCore
import XCTest

@testable import PennyUI

final class CardKindTests: XCTestCase {
    func testWriteAndBotCardsAreNotLabelledInvest() {
        XCTAssertEqual(CardKind(.write).tag, "✎ WRITE")
        XCTAssertEqual(CardKind(.write).crew, .penny)
        XCTAssertEqual(CardKind(.createBot).tag, "✦ NEW BOT")
        XCTAssertNotEqual(CardKind(.write), .invest)
        XCTAssertNotEqual(CardKind(.createBot), .invest)
    }

    func testMoneyKindsKeepTheirLabels() {
        XCTAssertEqual(CardKind(.invest).tag, "↗ INVEST")
        XCTAssertEqual(CardKind(.send).tag, "→ SEND")
        XCTAssertEqual(CardKind(.payBill).tag, "✉ BILL")
        XCTAssertEqual(CardKind(.errand).tag, "✦ ERRAND")
    }
}
