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
        // an email draft is a write in waiting: same colour, same meaning (DESIGN.md: one colour, one meaning)
        for other in CardKind.allCases where ![.write, .bot, .emailDraft].contains(other) {
            XCTAssertNotEqual(CardKind(.write).palette, other.palette)
            XCTAssertNotEqual(CardKind.bot.palette, other.palette)
        }
        // mono tags must not read the same as another card's
        let tags = CardKind.allCases.map(\.tag)
        XCTAssertEqual(Set(tags).count, tags.count)
    }

    func testEveryEngineCardTypeHasItsOwnKind() {
        // packages/shared KNOWN_CARD_TYPES: nothing falls back to `plain`
        XCTAssertEqual(CardKind(cardType: "connect"), .connect)
        XCTAssertEqual(CardKind(cardType: "setup"), .setup)
        XCTAssertEqual(CardKind(cardType: "unfreeze"), .unfreeze)
        for type in ["invest", "pick", "send", "pay_bill", "request", "errand", "guard_block",
                     "checkin", "write", "new_bot", "reminder", "email_draft", "plan", "found",
                     "done", "unfreeze", "connect", "setup"] {
            XCTAssertNotEqual(CardKind(cardType: type), .plain, type)
        }
    }

    func testFinishedCardsNameTheirOwnOutcome() {
        XCTAssertEqual(CardKind.send.settledLabel, "Sent")
        XCTAssertEqual(CardKind.bill.settledLabel, "Paid")
        XCTAssertEqual(CardKind.write.settledLabel, "Sent")
        XCTAssertEqual(CardKind.bot.settledLabel, "Created")
        XCTAssertEqual(CardKind.unfreeze.settledLabel, "Unfrozen")
        XCTAssertEqual(CardKind.found.settledLabel, "Found")
    }
}
