import PennyCore
import XCTest

@testable import PennyUI

/// State rendering for live cards: the same card JSON the link page renders.
final class LiveCardUITests: XCTestCase {
    private func card(_ state: String, kind: String = "approval", type: String = "send",
                      expiresAt: String = "2099-01-01T00:00:00.000Z", extra: [String: JSONValue] = [:]) throws -> PennyCard {
        var o: [String: JSONValue] = [
            "title": .string("Send 0.1 NEAR"), "amount": .string("0.1 NEAR"), "kind": .string(kind), "type": .string(type),
            "state": .string(state), "agent": .string("penny"), "expiresAt": .string(expiresAt),
            "lines": .array([.object(["label": .string("To"), "value": .string("amara.testnet")])]),
        ]
        for (k, v) in extra { o[k] = v }
        return try PennyCard.parse(.object(o))
    }

    func testEachStateRendersItsPhase() throws {
        let now = Date()
        XCTAssertEqual(CardPhase.from(card: try card("ready"), now: now), .ask)
        XCTAssertEqual(CardPhase.from(card: try card("ready", expiresAt: "2001-01-01T00:00:00.000Z"), now: now), .expired)
        if case .approved = CardPhase.from(card: try card("approving"), now: now) {} else { XCTFail("approving") }
        if case .done = CardPhase.from(card: try card("sent"), now: now) {} else { XCTFail("sent") }
        XCTAssertEqual(CardPhase.from(card: try card("blocked", extra: [
            "lines": .array([.object(["value": .string("That's over your $50 cap.")])]),
        ]), now: now), .blocked(message: "That's over your $50 cap."))
        XCTAssertEqual(CardPhase.from(card: try card("expired"), now: now), .expired)
        XCTAssertEqual(CardPhase.from(card: try card("declined"), now: now), .declined)
        if case .failed = CardPhase.from(card: try card("failed"), now: now) {} else { XCTFail("failed") }
        XCTAssertEqual(CardPhase.from(card: try card("done", kind: "info", type: "reminder"), now: now), .info)
        XCTAssertEqual(CardPhase.from(card: try card("undone", kind: "info", type: "reminder"), now: now), .closed(message: "Undone."))
    }

    func testReadyApprovalCardHasFaceIDAndNotNow() throws {
        let content = CardContent(card: try card("ready"), trailing: "1:30 left")
        XCTAssertEqual(content.buttons.map(\.title), ["Approve with Face ID", "Not now"])
        XCTAssertEqual(content.buttons.first?.style, .faceID)
        XCTAssertEqual(content.headline, "0.1 NEAR")
        XCTAssertEqual(content.trailing, "1:30 left")
        XCTAssertEqual(content.kind, .send)
    }

    func testInfoCardButtonsNeedNoFaceID() throws {
        let reminder = try card("done", kind: "info", type: "reminder", extra: [
            "title": .string("Reminder set for 7am"), "amount": .null,
            "buttons": .array([.object(["id": .string("undo"), "label": .string("Undo"), "action": .string("undo")])]),
        ])
        let content = CardContent(card: reminder, trailing: "")
        XCTAssertEqual(content.kind, .reminder)
        XCTAssertEqual(content.headline, "Reminder set for 7am")
        XCTAssertEqual(content.buttons.map(\.title), ["Undo"])
        XCTAssertTrue(content.buttons.allSatisfy { $0.style == .outline })
        XCTAssertEqual(content.buttons.first?.action, .button("undo"))
    }

    func testUnknownTypeIsAPlainCardNotACrash() throws {
        XCTAssertEqual(CardKind(cardType: "weather_report"), .plain)
        let content = CardContent(card: try card("done", kind: "info", type: "weather_report"), trailing: "")
        XCTAssertEqual(content.kind, .plain)
        XCTAssertEqual(content.tag, "● PENNY")
    }

    func testEngineTypesMapToTheirKinds() {
        XCTAssertEqual(CardKind(cardType: "email_draft"), .emailDraft)
        XCTAssertEqual(CardKind(cardType: "guard_block"), .guardBlock)
        XCTAssertEqual(CardKind(cardType: "new_bot"), .bot)
        XCTAssertEqual(CardKind(cardType: "write"), .write)
        XCTAssertEqual(CardKind(cardType: "pay_bill"), .bill)
    }
}
