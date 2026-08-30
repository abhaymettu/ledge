import ActivityKit
import SwiftUI

/// Two screens, picked by whether the phone has successfully paired: a three-step
/// setup for a first launch, and a status screen after that. The card on the lock
/// screen is designed in LedgeWidget; nothing here touches it.
@MainActor
struct ContentView: View {
    @Bindable private var store = LedgeStore.shared
    @State private var copied = false

    static let installCommand =
        "curl -fsSL https://raw.githubusercontent.com/abhaymettu/ledge/main/install.sh | sh"

    var body: some View {
        if store.handingOff || store.veiled {
            // The split second between the tap and Claude: a black frame that
            // says where it is going, instead of a flash of the settings form.
            // Also the first 0.4 s of any activation, before we know whether a
            // link is about to arrive.
            ZStack {
                Color.black.ignoresSafeArea()
                if store.handingOff {
                    Text("Opening in Claude")
                        .font(.system(size: 15, weight: .regular, design: .serif))
                        .foregroundStyle(.white.opacity(0.6))
                }
            }
        } else {
            screens
        }
    }

    private var screens: some View {
        NavigationStack {
            Form {
                if !ActivityAuthorizationInfo().areActivitiesEnabled {
                    activitiesOff
                }
                if store.paired { connected } else { setup }
            }
            .navigationTitle("Ledge")
        }
        .task { store.start() }
    }

    // MARK: - First launch

    @ViewBuilder private var setup: some View {
        Section {
            Text("Your coding agents, on the lock screen.")
                .font(.title3.weight(.semibold))
            Text("A card appears for every Claude Code session running on your Mac: what it is doing, and the question it asks when it needs you. Tap a card to open that session.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }

        Section {
            Text("Open a terminal and run:")
            command("ledge pair")
        } header: {
            Text("1. On your Mac")
        } footer: {
            Text("It prints a server address and a token. No server yet? Run the install command at the bottom of this screen first.")
        }

        Section("2. Enter what it printed") {
            serverFields
        }

        Section {
            Button("Pair") { Task { await store.register() } }
                .disabled(store.serverURL.isEmpty || store.token.isEmpty)
            statusLine
        } header: {
            Text("3. Pair")
        } footer: {
            Text("Both devices need to be on the same Tailscale network, or on the same Mac while testing.")
        }

        Section {
            command(Self.installCommand)
        } header: {
            Text("Install the server")
        } footer: {
            Text("Paste this into a terminal on your Mac, or hand it to your coding agent. It asks for your Apple details once, builds this app, and starts the server.")
        }
    }

    // MARK: - Paired

    @ViewBuilder private var connected: some View {
        Section {
            Label("Connected", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
            Text(store.serverURL)
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
        } footer: {
            Text("Cards appear on the lock screen by themselves once a session on your Mac has been working for a few seconds. Nothing else to do here.")
        }

        Section {
            Button("Restore missing cards") { Task { await store.restore() } }
            Button("Send a test card") { Task { await store.sendTest() } }
            statusLine
        } footer: {
            Text("Restore puts back any card swiped off the lock screen, right away. Test sends a canned card; lock the phone after tapping.")
        }

        Section {
            let live = store.activities
            if live.isEmpty {
                Text("Nothing running right now.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(live, id: \.id) { activity in
                    sessionRow(activity)
                }
            }
        } header: {
            Text("Sessions")
        } footer: {
            Text("Tap a session to open it in the Claude app. Swipe left to take its card off this phone.")
        }

        Section {
            DisclosureGroup("Server settings") {
                serverFields
                Button("Pair again") { Task { await store.register() } }
            }
        } footer: {
            Text("Reinstalling the app invalidates its push tokens. Opening the app once re-pairs it.")
        }
    }

    // MARK: - Sessions

    /// One live card as a row: what the card shows, plus whether a tap can go anywhere.
    /// A card with no link opens this screen instead of Claude; the row for that lane
    /// is highlighted and says why, because a tap that lands nowhere is the worst case.
    private func sessionRow(_ activity: Activity<AgentActivity>) -> some View {
        let state = activity.content.state
        let link = store.link(of: activity)
        let focused = activity.attributes.lane == store.focusedLane
        return Button {
            if let link {
                store.focusedLane = nil
                UIApplication.shared.open(link)
            } else {
                store.focusedLane = activity.attributes.lane
            }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Capsule()
                    .fill(toneColor(state))
                    .frame(width: 3, height: 34)
                VStack(alignment: .leading, spacing: 3) {
                    Text(state.title)
                        .font(.body.weight(.medium))
                        .foregroundStyle(.primary)
                    Text(state.line)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if focused && link == nil {
                        Text("This session can't be opened from the phone: Claude Code reported no bridge ID for it. Cards for sessions connected to the Claude app are tappable.")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(stateWord(state))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(toneColor(state))
                    if let at = state.startedAt {
                        Text(at, style: .timer)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    if link != nil {
                        Image(systemName: "arrow.up.forward.app")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .listRowBackground(focused ? Color.orange.opacity(0.08) : nil)
        .swipeActions(edge: .trailing) {
            Button("Dismiss", role: .destructive) { store.dismiss(activity) }
        }
    }

    private func stateWord(_ s: AgentActivity.ContentState) -> String {
        switch s.template {
        case "needs_you": "waiting on you"
        case "result": s.tone == "fail" ? "failed" : "done"
        case "countdown": "deadline"
        default: s.tone == "warn" ? "stuck" : "working"
        }
    }

    private func toneColor(_ s: AgentActivity.ContentState) -> Color {
        // Same colour-blind safe set as the card (see the widget's Tone).
        if s.template == "needs_you" { return Color(red: 0.40, green: 0.72, blue: 0.96) }
        if s.template == "progress" && s.tone == "neutral" { return Color(red: 0.96, green: 0.86, blue: 0.28) }
        return switch s.tone {
        case "warn": Color(red: 0.92, green: 0.42, blue: 0.05)
        case "ok": Color(red: 0.10, green: 0.78, blue: 0.58)
        case "fail": Color(red: 0.88, green: 0.48, blue: 0.75)
        default: .secondary
        }
    }

    // MARK: - Pieces

    private var activitiesOff: some View {
        Section {
            Text("Live Activities are off for Ledge, so no card can appear.")
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
        }
    }

    @ViewBuilder private var serverFields: some View {
        TextField("http://100.x.y.z:8787", text: $store.serverURL)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        SecureField("token", text: $store.token)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
    }

    @ViewBuilder private var statusLine: some View {
        if !store.status.isEmpty {
            Text(store.status)
                .font(.footnote)
                .foregroundStyle(store.failed ? Color.orange : Color.secondary)
                .textSelection(.enabled)
        }
    }

    private func command(_ text: String) -> some View {
        HStack {
            Text(text)
                .font(.footnote.monospaced())
                .textSelection(.enabled)
            Spacer()
            Button(copied ? "Copied" : "Copy") {
                UIPasteboard.general.string = text
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    copied = false
                }
            }
            .font(.footnote)
        }
    }
}

#Preview {
    ContentView()
}
