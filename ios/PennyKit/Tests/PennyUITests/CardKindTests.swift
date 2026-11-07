import PennyCore
import XCTest

@testable import PennyUI

final class CardKindTests: XCTestCase {
    func testWriteAndBotCardsAreNotLabelledInvest() {
        XCTAssertEqual(CardKind(.write).tag, "✎ WRITE")
        XCTAssertEqual(CardKind(.write).crew, .penny)
        XCTAssertEqual(CardKind(.createBot).tag, "✳ NEW BOT")
        XCTAssertNotEqual(CardKind(.write), .invest)
        XCTAssertNotEqual(CardKind(.createBot), .invest)
    }

    func testMoneyKindsKeepTheirLabels() {
        XCTAssertEqual(CardKind(.invest).tag, "↗ INVEST")
        XCTAssertEqual(CardKind(.send).tag, "→ SEND")
        XCTAssertEqual(CardKind(.payBill).tag, "✉ BILL")
        XCTAssertEqual(CardKind(.errand).tag, "✦ ERRAND")
    }

    func testWriteAndBotOwnColoursFromTheDesignSystem() {
        XCTAssertEqual(CardKind(.write).palette, .indigo)
        XCTAssertEqual(CardKind.bot.palette, .amber)
        for other in CardKind.allCases where other != .write && other != .bot {
            XCTAssertNotEqual(CardKind(.write).palette, other.palette)
            XCTAssertNotEqual(CardKind.bot.palette, other.palette)
        }
        // mono tags must not read the same as another card's
        let tags = CardKind.allCases.map(\.tag)
        XCTAssertEqual(Set(tags).count, tags.count)
    }
}
