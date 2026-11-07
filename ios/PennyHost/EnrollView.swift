import PennyCore
import PennyUI
import SwiftUI

/// First run: enter the 8-character code Penny texted you. The key is made here and never leaves.
struct EnrollView: View {
    @EnvironmentObject private var session: HostSession
    @State private var code = ""
    @State private var working = false
    @State private var errorText: String?
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    CrewChip(.penny, size: 30)
                    Text("Penny").font(.geist(15, medium: true)).foregroundStyle(PennyColor.text)
                }
                .padding(.bottom, 36)

                Eyebrow("Link this iPhone")
                Text("Enter the code Penny texted you.")
                    .font(.geist(26))
                    .tracking(-0.8)
                    .foregroundStyle(PennyColor.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
                Text("Penny helps with the everyday stuff — inbox, bills, errands, money. The key that approves actions in your name is made on this iPhone and stays here, locked behind Face ID. Penny never sees it.")
                    .font(.geist(14))
                    .foregroundStyle(PennyColor.meta)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 10)

                CodeField(code: $code, focused: $focused)
                    .padding(.top, 28)

                if let errorText {
                    Text(errorText)
                        .font(.geist(13))
                        .foregroundStyle(PennyColor.errorText)
                        .padding(.top, 12)
                }

                Button {
                    Task { await submit() }
                } label: {
                    HStack(spacing: 8) {
                        if working { ProgressView().tint(PennyColor.ink) }
                        Text(working ? "Linking" : "Link this iPhone")
                            .font(.geist(15, medium: true))
                    }
                    .foregroundStyle(PennyColor.ink)
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
                    .background(Capsule().fill(Color.white.opacity(EnrollCode.isValid(code) ? 1 : 0.35)))
                }
                .buttonStyle(.plain)
                .disabled(!EnrollCode.isValid(code) || working)
                .padding(.top, 20)

                if !DeviceKeyStore.canUseBiometrics {
                    Text("Turn on Face ID and a passcode in Settings first. Penny uses them to protect your key.")
                        .font(.geist(13))
                        .foregroundStyle(PennyColor.meta)
                        .padding(.top, 14)
                }

                Spacer(minLength: 40)

                NavigationLink {
                    SettingsEngineView()
                } label: {
                    Text("Server: \(session.engineURL?.host ?? "not set")")
                        .font(.geistMono(11))
                        .foregroundStyle(PennyColor.meta.opacity(0.7))
                }
                .padding(.top, 40)
            }
            .padding(24)
            .frame(maxWidth: 520, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(PennyColor.cardBackground.ignoresSafeArea())
        .onAppear {
            focused = true
            consumeLinkCode()
        }
        .onChange(of: session.linkCode) { _, _ in consumeLinkCode() }
        .embedInNavigation()
    }

    /// A tapped enroll link fills the code and submits itself — no typing.
    private func consumeLinkCode() {
        guard let link = session.linkCode, EnrollCode.isValid(link) else { return }
        session.linkCode = nil
        code = link
        Task { await submit() }
    }

    private func submit() async {
        working = true
        errorText = nil
        defer { working = false }
        do {
            try await session.enroll(code: code)
        } catch let error as PennyError {
            switch error {
            case .http(status: 400), .http(status: 404), .http(status: 410), .http(status: 422):
                errorText = "That code didn't work. Codes last 10 minutes and work once. Text Penny for a new one."
            case let .invalidInput(message):
                errorText = message
            default:
                errorText = error.errorDescription
            }
        } catch {
            errorText = "Something went wrong. Try again."
        }
    }
}

/// Eight boxes over a hidden text field; only the code alphabet gets through.
private struct CodeField: View {
    @Binding var code: String
    var focused: FocusState<Bool>.Binding

    var body: some View {
        ZStack {
            TextField("", text: Binding(
                get: { code },
                set: { code = EnrollCode.normalize($0) }
            ))
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .keyboardType(.asciiCapable)
            .textContentType(.oneTimeCode)
            .focused(focused)
            .foregroundStyle(.clear)
            .tint(.clear)
            .frame(height: 1)
            .opacity(0.02)

            HStack(spacing: 6) {
                ForEach(0..<8, id: \.self) { index in
                    let chars = Array(code)
                    Text(index < chars.count ? String(chars[index]) : "")
                        .font(.geistMono(22, medium: true))
                        .foregroundStyle(PennyColor.text)
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.04)))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .strokeBorder(index == chars.count && focused.wrappedValue ? Color.white.opacity(0.6) : PennyColor.border, lineWidth: 1)
                        )
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { focused.wrappedValue = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Enrollment code"))
        .accessibilityValue(Text(code))
    }
}

struct Eyebrow: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text.uppercased())
            .font(.geistMono(10.5))
            .tracking(0.9)
            .foregroundStyle(PennyColor.meta)
    }
}

extension View {
    func embedInNavigation() -> some View {
        NavigationStack { self }
    }
}
