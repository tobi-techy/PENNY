import PennyCore
import PennyUI
import SwiftUI
import UIKit

/// After enrolment: account, device key, limits, and the card gallery.
struct HomeView: View {
    @EnvironmentObject private var session: HostSession
    @State private var copied = false
    @State private var confirmRevoke = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    header

                    SettingsSection(title: "Account") {
                        Row(label: "Wallet", value: session.accountId ?? "—", mono: true)
                        if session.dryRun {
                            Row(label: "Mode", value: "Test run · nothing on mainnet yet")
                        }
                        Button {
                            if let key = session.publicKey?.nearString {
                                UIPasteboard.general.string = key
                                copied = true
                            }
                        } label: {
                            Row(label: "This iPhone's key", value: copied ? "Copied" : shortKey, mono: true)
                        }
                        .buttonStyle(.plain)
                    }

                    SettingsSection(title: "Limits") {
                        Row(label: "Ask me above", value: "Set by Guard")
                        Row(label: "Daily limit", value: "Set by Guard")
                        Row(label: "New recipients", value: "Always ask")
                        Text("Guard checks every payment against your limits before a card reaches you. Text Penny “show my limits” to see or change them.")
                            .font(.geist(12.5))
                            .foregroundStyle(PennyColor.meta)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 10)
                    }

                    SettingsSection(title: "Device") {
                        Button { confirmRevoke = true } label: {
                            Row(label: "Remove this iPhone", value: "Coming soon")
                        }
                        .buttonStyle(.plain)
                        NavigationLink { SettingsEngineView() } label: {
                            Row(label: "Server", value: session.engineURL?.host ?? "not set", mono: true)
                        }
                        .buttonStyle(.plain)
                        NavigationLink { CardGalleryView() } label: {
                            Row(label: "Card gallery", value: "8 cards ›")
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(24)
                .frame(maxWidth: 560, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .background(PennyColor.cardBackground.ignoresSafeArea())
            .alert("Not yet", isPresented: $confirmRevoke) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("Removing a device will swap this key off your wallet on-chain first, so you never lose access. That flow is still being built, so for now the key stays put.")
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                CrewChip(.penny, size: 30)
                Text("Penny").font(.geist(15, medium: true)).foregroundStyle(PennyColor.text)
            }
            .padding(.bottom, 20)
            Eyebrow("Linked")
            Text("You're set. Text Penny what you need.")
                .font(.geist(24))
                .tracking(-0.7)
                .foregroundStyle(PennyColor.text)
                .fixedSize(horizontal: false, vertical: true)
            Text("Cards to approve show up in your Messages thread. Each one needs your Face ID.")
                .font(.geist(14))
                .foregroundStyle(PennyColor.meta)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var shortKey: String {
        guard let key = session.publicKey?.nearString else { return "—" }
        return key.count > 22 ? String(key.prefix(14)) + "…" + String(key.suffix(6)) : key
    }
}

private struct SettingsSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow(title).padding(.bottom, 8)
            Rectangle().fill(PennyColor.hairline).frame(height: 1)
            content
        }
    }
}

private struct Row: View {
    let label: String
    let value: String
    var mono = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text(label).font(.geist(14)).foregroundStyle(PennyColor.meta)
                Spacer(minLength: 12)
                Text(value)
                    .font(mono ? .geistMono(12.5) : .geist(14))
                    .foregroundStyle(PennyColor.text)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(.vertical, 13)
            .contentShape(Rectangle())
            Rectangle().fill(PennyColor.hairlineSoft).frame(height: 1)
        }
    }
}

/// Engine URL. Editable in Debug builds; Release builds use Info.plist PennyEngineURL.
struct SettingsEngineView: View {
    @EnvironmentObject private var session: HostSession
    @State private var text = ""
    @State private var status: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Eyebrow("Server")
            #if DEBUG
            TextField("https://penny-engine.example.com", text: $text)
                .font(.geistMono(13))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).strokeBorder(PennyColor.border, lineWidth: 1))
            HStack(spacing: 10) {
                Button("Save") {
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if trimmed.isEmpty {
                        session.setEngineURL(nil)
                        status = "Using the built-in server."
                    } else if let url = URL(string: trimmed), url.scheme == "https" || url.host == "localhost" {
                        session.setEngineURL(url)
                        status = "Saved."
                    } else {
                        status = "Use an https:// address."
                    }
                }
                Button("Check") {
                    Task {
                        guard let url = session.engineURL else { status = "No server set."; return }
                        status = await EngineClient(baseURL: url).health() ? "Server is up." : "Can't reach the server."
                    }
                }
            }
            .font(.geist(14, medium: true))
            #else
            Text(session.engineURL?.absoluteString ?? "not set")
                .font(.geistMono(13))
                .foregroundStyle(PennyColor.text)
            #endif
            if let status {
                Text(status).font(.geist(13)).foregroundStyle(PennyColor.meta)
            }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PennyColor.cardBackground.ignoresSafeArea())
        .onAppear { text = session.engineURL?.absoluteString ?? "" }
    }
}

/// All eight cards and the four moments, for checking the design on a real phone.
struct CardGalleryView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Eyebrow("Eight cards, one shape")
                ForEach(CardSamples.all, id: \.kind) { card in
                    PennyCardView(content: card)
                }
                Eyebrow("One card, four moments").padding(.top, 20)
                PennyCardView(content: CardSamples.invest, phase: .ask)
                PennyCardView(content: CardSamples.invest, phase: .approving)
                PennyCardView(content: CardSamples.invest, phase: .approved(steps: CardSamples.approvedSteps))
                PennyCardView(content: CardSamples.invest, phase: .done(steps: CardSamples.doneSteps, at: Date()))
                PennyCardView(content: CardSamples.invest, phase: .expired)
            }
            .frame(maxWidth: 300)
            .padding(24)
            .frame(maxWidth: .infinity)
        }
        .background(Color.black.ignoresSafeArea())
    }
}
