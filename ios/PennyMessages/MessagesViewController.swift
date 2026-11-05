import Messages
import PennyCore
import PennyUI
import SwiftUI
import UIKit

/// iMessage extension. Penny's engine sends a live-layout message (MSMessageLiveLayout) whose URL
/// carries the approvalId + cardToken. Messages creates one instance of this controller per live
/// bubble with `presentationStyle == .transcript`; tapping a bubble opens `.expanded`.
final class MessagesViewController: MSMessagesAppViewController {
    private var host: UIHostingController<AnyView>?
    private var model: ApprovalCardModel?

    override func viewDidLoad() {
        super.viewDidLoad()
        PennyFonts.register()
        view.backgroundColor = .clear
    }

    // MARK: Conversation lifecycle

    override func willBecomeActive(with conversation: MSConversation) {
        super.willBecomeActive(with: conversation)
        render(conversation: conversation)
    }

    override func didResignActive(with conversation: MSConversation) {
        super.didResignActive(with: conversation)
        model?.stop()
    }

    override func willTransition(to presentationStyle: MSMessagesAppPresentationStyle) {
        super.willTransition(to: presentationStyle)
    }

    override func didTransition(to presentationStyle: MSMessagesAppPresentationStyle) {
        super.didTransition(to: presentationStyle)
        render(conversation: activeConversation)
    }

    override func didSelect(_ message: MSMessage, conversation: MSConversation) {
        super.didSelect(message, conversation: conversation)
        render(conversation: conversation)
    }

    override func didReceive(_ message: MSMessage, conversation: MSConversation) {
        super.didReceive(message, conversation: conversation)
        // The engine edits the card in place; refresh if it's ours.
        if let url = message.url, let link = CardLink(url: url), link == model?.link {
            Task { await model?.load() }
        }
    }

    // MARK: Rendering

    private func render(conversation: MSConversation?) {
        let style = presentationStyle
        let link = conversation?.selectedMessage?.url.flatMap(CardLink.init(url:))

        let root: AnyView
        if let link, style == .transcript || style == .expanded {
            let model = makeModel(for: link)
            let presentation: CardPresentation = style == .transcript ? .transcript : .expanded
            root = AnyView(
                ApprovalCardScreen(model: model, presentation: presentation) { [weak self] in
                    self?.requestPresentationStyle(.expanded)
                }
                .environment(\.colorScheme, .dark)
            )
        } else {
            root = AnyView(DrawerView().environment(\.colorScheme, .dark))
        }
        install(root)
    }

    private func makeModel(for link: CardLink) -> ApprovalCardModel {
        if let model, model.link == link {
            model.start()
            return model
        }
        model?.stop()
        let config = SharedConfig.shared
        let baseURL = config.engineURL ?? URL(string: "https://localhost")!
        let newModel = ApprovalCardModel(
            link: link,
            client: EngineClient(baseURL: baseURL),
            signer: DeviceKeyStore.shared,
            expectedAccountId: config.accountId
        )
        newModel.onNeedsExpandedPresentation = { [weak self] in
            self?.requestPresentationStyle(.expanded)
        }
        model = newModel
        newModel.start()
        return newModel
    }

    private func install(_ root: AnyView) {
        if let host {
            host.rootView = root
        } else {
            let hosting = UIHostingController(rootView: root)
            hosting.view.backgroundColor = .clear
            addChild(hosting)
            hosting.view.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(hosting.view)
            NSLayoutConstraint.activate([
                hosting.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                hosting.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                hosting.view.topAnchor.constraint(equalTo: view.topAnchor),
                hosting.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            ])
            hosting.didMove(toParent: self)
            host = hosting
        }
    }

    // MARK: Live layout sizing (MSMessagesAppTranscriptPresentation)

    override func contentSizeThatFits(_ size: CGSize) -> CGSize {
        guard let host else { return CGSize(width: size.width, height: min(size.height, 360)) }
        let fitting = host.sizeThatFits(in: CGSize(width: size.width, height: .greatestFiniteMagnitude))
        return CGSize(width: size.width, height: min(size.height, ceil(fitting.height)))
    }
}

/// Shown when Penny is opened from the app drawer rather than from a card.
private struct DrawerView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                CrewChip(.penny, size: 30)
                Text("Penny").font(.geist(15, medium: true)).foregroundStyle(PennyColor.text)
            }
            Text(SharedConfig.shared.isEnrolled
                 ? "Text Penny what you need. Cards to approve show up right in this thread."
                 : "Open the Penny app to link this iPhone, then text Penny.")
                .font(.geist(13))
                .foregroundStyle(PennyColor.meta)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(PennyColor.cardBackground)
    }
}
