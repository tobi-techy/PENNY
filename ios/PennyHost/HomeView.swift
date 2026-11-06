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
                        NavigationLink { LimitsView() } label: {
                            Row(label: "Edit limits", value: "Face ID ›")
                        }
                        .buttonStyle(.plain)
                        Text("Guard checks every payment against your limits before a card reaches you. Changing them needs Face ID on this iPhone.")
                            .font(.geist(12.5))
                            .foregroundStyle(PennyColor.meta)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 10)
                    }

                    SettingsSection(title: "History") {
                        NavigationLink { HistoryView() } label: {
                            Row(label: "Approvals", value: "Recent ›")
                        }
                        .buttonStyle(.plain)
                    }

                    SettingsSection(title: "Device") {
                        Button(role: .destructive) { confirmRevoke = true } label: {
                            Row(label: "Remove this iPhone", value: "Revoke key")
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
            .alert("Remove this iPhone?", isPresented: $confirmRevoke) {
                Button("Cancel", role: .cancel) {}
                Button("Remove", role: .destructive) {
                    Task { try? await session.removeThisIPhone() }
                }
            } message: {
                Text("This iPhone's key will be revoked on the server and deleted here. It will no longer be able to approve anything. You can pair a new iPhone later.")
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

/// Edit Guard limits. Values are decimal USD strings; saving needs Face ID.
struct LimitsView: View {
    @EnvironmentObject private var session: HostSession
    @State private var perTx = "25"
    @State private var daily = "100"
    @State private var blockNew = "20"
    @State private var saved = false
    @State private var failed = false

    var body: some View {
        Form {
            Section("Per payment") { TextField("25", text: $perTx).keyboardType(.decimalPad) }
            Section("Per day") { TextField("100", text: $daily).keyboardType(.decimalPad) }
            Section("First payment to someone new") { TextField("20", text: $blockNew).keyboardType(.decimalPad) }
            Section {
                Button("Save with Face ID") {
                    Task {
                        do {
                            try await session.updateLimits(perTx: perTx, daily: daily, blockNew: blockNew)
                            saved = true
                        } catch { failed = true }
                    }
                }
            }
            if saved { Section { Text("Saved. Guard uses these from the next payment.") } }
            if failed { Section { Text("That did not save. Check the amounts and try again.") } }
        }
        .navigationTitle("Limits")
    }
}

/// Recent approvals from the engine (device-signed request).
struct HistoryView: View {
    @EnvironmentObject private var session: HostSession
    @State private var items: [ApprovalHistoryItem] = []
    @State private var failed = false

    var body: some View {
        List {
            if items.isEmpty && !failed {
                Text("Nothing yet. Approvals you make will show up here.")
            }
            if failed {
                Text("Could not load history. Try again in a moment.")
            }
            ForEach(items, id: \.id) { item in
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title).font(.geist(14, medium: true))
                    Text("\(item.amountDisplay) · \(item.status)")
                        .font(.geist(12.5))
                        .foregroundStyle(PennyColor.meta)
                }
                .padding(.vertical, 4)
            }
        }
        .navigationTitle("Approvals")
        .task {
            do { items = try await session.approvalHistory() } catch { failed = true }
        }
    }
}
