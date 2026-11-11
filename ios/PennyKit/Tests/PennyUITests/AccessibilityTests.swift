import SwiftUI
import XCTest
@testable import PennyCore
@testable import PennyUI

@MainActor
final class AccessibilityTests: XCTestCase {
    func testAFinishedInfoCardHasItsOwnPhaseAndOutcome() throws {
        let card = try PennyCard.parse(.object([
            "id": .string("crd_01JC0000000000000000000000"),
            "agent": .string("penny"),
            "kind": .string("info"),
            "type": .string("connect"),
            "title": .string("Gmail connected"),
            "state": .string("done"),
        ]))
        XCTAssertEqual(CardPhase.from(card: card, now: Date()), .infoDone)
        XCTAssertEqual(CardPhase.infoDone.mood, .calm)
        XCTAssertEqual(CardKind(cardType: card.type).settledLabel, "Connected")
    }

    func testTheCardRendersAtTheLargestAccessibilitySize() {
        let view = PennyCardView(content: CardSamples.bill, phase: .infoDone)
            .frame(width: 320)
            .environment(\.dynamicTypeSize, .accessibility5)
        let renderer = ImageRenderer(content: view)
        #if canImport(AppKit)
        let image = renderer.nsImage
        XCTAssertNotNil(image)
        XCTAssertGreaterThan(image?.size.width ?? 0, 0)
        XCTAssertGreaterThan(image?.size.height ?? 0, 0)
        #endif
    }
}
