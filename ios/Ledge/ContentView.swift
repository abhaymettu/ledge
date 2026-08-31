import ActivityKit
import SwiftUI

// MARK: - The card's language, on the app's screens

private extension AgentActivity.ContentState {
    /// The act, falling back to line for a server too old to send a headline.
    var act: String { headline.map { $0.isEmpty ? line : $0 } ?? line }

    var detail: String? {
        guard let subline, !subline.isEmpty else { return nil }
        return subline
    }
}

private extension Font {
    static let mono = Font.system(size: 11, weight: .medium, design: .monospaced)
    static let monoSmall = Font.system(size: 10, weight: .medium, design: .monospaced)
    static let serif = Font.system(size: 17, weight: .regular, design: .serif)
    static let headline = Font.system(size: 28, weight: .regular, design: .serif)
}

/// A card on a screen: the lock-screen slab, minus the bloom, plus room to breathe.
private struct Slab<Content: View>: View {
    let accent: Color
    var loud = false
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(.black)
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(
                                LinearGradient(
                                    stops: [
                                        .init(color: accent.opacity(loud ? 0.65 : 0.36), location: 0),
                                        .init(color: .white.opacity(0.06), location: 0.3),
                                        .init(color: .white.opacity(0.04), location: 1),
                                    ],
                                    startPoint: .top, endPoint: .bottom
                                ),
                                lineWidth: 0.8
                            )
                    )
            )
    }
}

private struct StateMark: View {
    let state: CardState
    let tint: Color
    var size: CGFloat = 10

    var body: some View {
        Image(systemName: state.mark)
            .font(.system(size: size, weight: .semibold))
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(tint)
            .frame(width: size + 3, alignment: .leading)
            .accessibilityLabel(Ink.word(state))
    }
}

private struct SectionLabel: View {
    let text: String
    var trailing: String = ""
    /// Pass a binding and the whole label becomes the hit target for folding the
    /// section away. Nil keeps the plain label the other sections use.
    var collapsed: Binding<Bool>? = nil

    var body: some View {
        let row = HStack(spacing: 6) {
            Text(text).font(.mono).foregroundStyle(Ink.dim)
            if let collapsed {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Ink.faint)
                    .rotationEffect(.degrees(collapsed.wrappedValue ? 0 : 90))
            }
            Spacer()
            Text(trailing).font(.mono).foregroundStyle(Ink.faint)
        }
        .contentShape(.rect)
        .padding(.horizontal, 4)
        .padding(.top, 14)

        if let collapsed {
            Button {
                withAnimation(.snappy(duration: 0.22)) { collapsed.wrappedValue.toggle() }
            } label: { row }
            .buttonStyle(.plain)
        } else {
            row
        }
    }
}

private struct Empty: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.serif)
            .foregroundStyle(Ink.faint)
            .padding(.horizontal, 4)
            .padding(.vertical, 6)
    }
}

private struct Pill: View {
    let label: String
    var filled: Color? = nil
    var body: some View {
        Text(label)
            .font(.system(size: 12, weight: filled == nil ? .medium : .semibold, design: .monospaced))
            .foregroundStyle(filled == nil ? .white.opacity(0.85) : .black)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(Capsule().fill(filled ?? .white.opacity(0.10)))
    }
}

private struct Field: View {
    let label: String
    @Binding var text: String
    var secure = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.monoSmall).foregroundStyle(Ink.dim)
            Group {
                if secure { SecureField("", text: $text) } else { TextField("", text: $text) }
            }
            .font(.system(size: 15, design: .monospaced))
            .foregroundStyle(.white)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.white.opacity(0.06)))
        }
    }
}

// MARK: - Screens

@MainActor
struct ContentView: View {
    @Bindable private var store = LedgeStore.shared
    @State private var showSettings = false
    @State private var refreshing = false
    // What the refresh reported, held briefly then dropped. A button that restores
    // nothing and says nothing reads as broken.
    @State private var note = ""
    // Survives relaunch: a section he folded away should stay folded.
    @AppStorage("doneTodayCollapsed") private var doneCollapsed = false

    static let installCommand =
        "curl -fsSL https://raw.githubusercontent.com/abhaymettu/ledge/main/install.sh | sh"

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if store.handingOff || store.veiled {
                if store.handingOff {
                    Text("Opening in Claude").font(.serif).foregroundStyle(Ink.dim)
                }
            } else if store.paired {
                inbox
            } else {
                setup
            }
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showSettings) { settings }
        .task { store.start(); store.activated() }
        .task(id: store.paired) {
            guard store.paired else { return }
            while !Task.isCancelled {
                await store.refreshInbox()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    /// An error outranks the refresh result; both share the one reserved line.
    private var statusLine: String {
        store.failed && !store.status.isEmpty ? store.status : note
    }

    /// Pull the lists again and put back any card swiped off the lock screen. Restore
    /// is the slow half (it waits on iOS for a push token per lane), so the label
    /// stays busy until both finish.
    private func refresh() {
        guard !refreshing else { return }
        refreshing = true
        note = ""
        Task {
            await store.refreshInbox()
            await store.restore()
            refreshing = false
            note = store.status
            try? await Task.sleep(for: .seconds(4))
            note = ""
        }
    }

    // MARK: Inbox

    private var inbox: some View {
        let live = store.activities
        let asking = live.filter { $0.content.state.state == .asking }
        let running = live.filter { [.working, .stuck, .resting].contains($0.content.state.state) }
        let idle = live.filter { $0.content.state.state == .idle }
        let dayStart = Calendar.current.startOfDay(for: .now).timeIntervalSince1970
        var seenLanes = Set<String>()
        let ended = store.history.filter { $0.endedAt / 1000 >= dayStart && seenLanes.insert($0.lane).inserted }
        let need = store.approvals.count + asking.count
        // The shape of the list, not its contents. A card changing its line must not
        // animate anything; a section arriving or leaving, or a card moving between
        // sections, should glide rather than snap. doneCollapsed is deliberately absent:
        // the label's own withAnimation already carries that one.
        let shape = "\(need)|\(running.count)|\(idle.count)|\(ended.count)"

        return ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 16) {
                    Text("ledge").font(.mono).foregroundStyle(Ink.dim)
                    Spacer()
                    Button { refresh() } label: {
                        Text(refreshing ? "refreshing" : "refresh")
                            .font(.mono)
                            .foregroundStyle(refreshing ? Ink.faint : Ink.dim)
                    }
                    .disabled(refreshing)
                    Button { showSettings = true } label: {
                        Text("settings").font(.mono).foregroundStyle(Ink.dim)
                    }
                }
                .padding(.horizontal, 4)
                .padding(.top, 8)

                Text(need == 0 ? "Nothing needs you." : need == 1 ? "One thing needs you." : "\(need) things need you.")
                    .font(.headline)
                    .foregroundStyle(need == 0 ? Ink.dim : .white)
                    .padding(.horizontal, 4)
                    .padding(.bottom, 6)

                // One reserved line, never inserted or removed. It used to appear and
                // vanish as the status came and went, and everything under it jumped
                // by its height each time. Holding the row costs 13pt of black and
                // keeps the whole list still.
                // contentTransition cross-fades one string into the next; a plain
                // .animation on a Text only swaps it. Paired with the reserved height,
                // the line now dissolves in and out instead of snapping, and nothing
                // below it ever moves.
                Text(statusLine)
                    .font(.monoSmall)
                    .foregroundStyle(store.failed ? Ink.stuck : Ink.dim)
                    .lineLimit(1)
                    .contentTransition(.opacity)
                    .frame(height: 13, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                    .animation(.easeInOut(duration: 0.28), value: statusLine)

                if need > 0 {
                    SectionLabel(text: "needs you")
                    ForEach(store.approvals) { approval in
                        approvalCard(approval, title: live.first { $0.content.state.approvalId == approval.id }?.content.state.title)
                    }
                    ForEach(asking, id: \.id) { sessionCard($0) }
                }

                SectionLabel(text: "running", trailing: running.isEmpty ? "" : "\(running.count)")
                if running.isEmpty { Empty(text: "Nothing running. Start a session on your Mac.") }
                ForEach(running, id: \.id) { sessionCard($0) }

                if !idle.isEmpty {
                    SectionLabel(text: "idle", trailing: "\(idle.count)")
                    ForEach(idle, id: \.id) { sessionCard($0) }
                }

                SectionLabel(text: "done today", trailing: ended.isEmpty ? "" : "\(ended.count)", collapsed: $doneCollapsed)
                if !doneCollapsed {
                    if ended.isEmpty { Empty(text: "Nothing finished yet.") }
                    ForEach(ended) { endedCard($0) }
                }

                Text("Tap a session to open it in Claude. Swipe a card off the lock screen and it comes back from settings.")
                    .font(.monoSmall)
                    .foregroundStyle(Ink.faint)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 18)
            }
            .padding(.horizontal, 16)
            .animation(.easeInOut(duration: 0.26), value: shape)
        }
    }

    private func sessionCard(_ activity: Activity<AgentActivity>) -> some View {
        let state = activity.content.state
        let link = store.link(of: activity)
        let focused = activity.attributes.lane == store.focusedLane
        return Button {
            if let link {
                store.focusedLane = nil
                UIApplication.shared.open(link)
            } else {
                store.focusedLane = focused ? nil : activity.attributes.lane
            }
        } label: {
            Slab(accent: Ink.of(state.state), loud: state.state == .asking || focused) {
                // Same four parts as the card, same order: mark, name, act, detail.
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 5) {
                        StateMark(state: state.state, tint: Ink.of(state.state))
                        Text(state.title).font(.mono).foregroundStyle(Ink.of(state.state)).lineLimit(1).layoutPriority(1)
                        Spacer(minLength: 8)
                        // The word stays here and the glyph leads the row. On the
                        // card the glyph is alone because there is no room for a
                        // word; a list row has the width, and a list is read one
                        // row against the next, where a word sorts faster than a
                        // shape. Two channels for one fact is the point, not a
                        // redundancy: it is the same reason the palette is
                        // Okabe-Ito rather than whatever looked nice.
                        Text(Ink.word(state.state)).font(.monoSmall).foregroundStyle(Ink.dim)
                        if let at = state.state == .resting ? state.deadline : state.startedAt {
                            Text(at, style: .timer)
                                .font(.monoSmall).monospacedDigit()
                                .foregroundStyle(Ink.dim)
                                .multilineTextAlignment(.trailing)
                                .frame(maxWidth: 58, alignment: .trailing)
                        }
                    }
                    Text(state.act).font(.serif).foregroundStyle(.white).lineLimit(2)
                    if let detail = state.detail {
                        Text(detail).font(.monoSmall).foregroundStyle(.white.opacity(0.45)).lineLimit(1)
                    }
                    if focused && link == nil {
                        Text("No link: this session is not connected to the Claude app, so it opens nowhere. It is still running on the Mac.")
                            .font(.monoSmall).foregroundStyle(Ink.stuck)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Take off this phone", role: .destructive) { store.dismiss(activity) }
        }
    }

    private func approvalCard(_ approval: LedgeStore.Approval, title: String?) -> some View {
        Slab(accent: Ink.ask, loud: true) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 0) {
                    Text(title ?? approval.tool).font(.mono).foregroundStyle(Ink.ask).lineLimit(1).layoutPriority(1)
                    Spacer(minLength: 8)
                    Text(Date(timeIntervalSince1970: approval.at / 1000), style: .timer)
                        .font(.monoSmall).monospacedDigit().foregroundStyle(Ink.dim)
                        .multilineTextAlignment(.trailing).frame(maxWidth: 58, alignment: .trailing)
                }
                Text("allow: \(approval.summary)").font(.serif).foregroundStyle(.white).lineLimit(3)
                // A tap that did not reach the Mac says so on the card it was tapped
                // on, in the same words the lock screen uses. The glyph carries it
                // too, so the row does not depend on the colour being read.
                if let error = store.decideFailures[approval.id] {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.monoSmall).foregroundStyle(.white.opacity(0.75)).lineLimit(2)
                }
                HStack(spacing: 8) {
                    Button { Task { await store.decide(approval, "deny") } } label: { Pill(label: "deny") }
                    Button { Task { await store.decide(approval, "allow") } } label: { Pill(label: "allow", filled: Ink.ask) }
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func endedCard(_ ended: LedgeStore.Ended) -> some View {
        Slab(accent: ended.outcome == "failed" ? Ink.failed : Ink.done) {
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 5) {
                        StateMark(state: ended.outcome == "failed" ? .failed : .done,
                                  tint: ended.outcome == "failed" ? Ink.failed : Ink.done, size: 9)
                        Text(ended.card.title).font(.mono)
                            .foregroundStyle(ended.outcome == "failed" ? Ink.failed : Ink.done).lineLimit(1)
                    }
                    Text(ended.card.act).font(.serif).foregroundStyle(.white.opacity(0.8)).lineLimit(1)
                    if let detail = ended.card.detail {
                        Text(detail).font(.monoSmall).foregroundStyle(.white.opacity(0.35)).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                Text(Date(timeIntervalSince1970: ended.endedAt / 1000), style: .time)
                    .font(.monoSmall).foregroundStyle(Ink.dim)
            }
        }
    }

    // MARK: Setup, first launch

    private var setup: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("ledge").font(.mono).foregroundStyle(Ink.dim).padding(.top, 8)
                Text("Your coding agents,\non the lock screen.").font(.headline).foregroundStyle(.white)
                Text("A card for every Claude Code session on your Mac: what it is doing, and the question it asks when it needs you. Approve a command without unlocking. Tap a card to open the session.")
                    .font(.serif).foregroundStyle(Ink.dim)

                SectionLabel(text: "1  on your mac")
                Slab(accent: Ink.dim) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("ledge pair").font(.system(size: 15, design: .monospaced)).foregroundStyle(.white)
                        Text("prints the address and the token. No server yet? The install command is at the bottom.").font(.monoSmall).foregroundStyle(Ink.dim)
                    }
                }

                SectionLabel(text: "2  type what it printed")
                Field(label: "server", text: $store.serverURL)
                Field(label: "token", text: $store.token, secure: true)

                SectionLabel(text: "3  pair")
                HStack(spacing: 10) {
                    Button { Task { await store.register(manual: true) } } label: { Pill(label: "pair", filled: Ink.ask) }
                        .buttonStyle(.plain)
                        .disabled(store.serverURL.isEmpty || store.token.isEmpty)
                        .opacity(store.serverURL.isEmpty || store.token.isEmpty ? 0.4 : 1)
                    if !store.status.isEmpty {
                        Text(store.status).font(.monoSmall).foregroundStyle(store.failed ? Ink.stuck : Ink.dim)
                    }
                }
                Text("Both devices on the same Tailscale network, or the same Mac while testing.").font(.monoSmall).foregroundStyle(Ink.faint)

                SectionLabel(text: "install the server")
                Slab(accent: Ink.dim) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(Self.installCommand).font(.system(size: 12, design: .monospaced)).foregroundStyle(.white).textSelection(.enabled)
                        Button { UIPasteboard.general.string = Self.installCommand } label: { Pill(label: "copy") }.buttonStyle(.plain)
                        Text("Paste it into a terminal on your Mac, or hand it to your coding agent.").font(.monoSmall).foregroundStyle(Ink.dim)
                    }
                }
                Spacer(minLength: 30)
            }
            .padding(.horizontal, 20)
        }
    }

    // MARK: Settings

    private var settings: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        Text("settings").font(.mono).foregroundStyle(Ink.dim)
                        Spacer()
                        Button { showSettings = false } label: { Text("done").font(.mono).foregroundStyle(.white) }
                    }
                    .padding(.top, 18)
                    Field(label: "server", text: $store.serverURL)
                    Field(label: "token", text: $store.token, secure: true)
                    HStack(spacing: 10) {
                        Button { Task { await store.register(manual: true) } } label: { Pill(label: "pair again") }
                        Button { Task { await store.restore() } } label: { Pill(label: "restore cards") }
                    }
                    .buttonStyle(.plain)
                    if !store.status.isEmpty {
                        Text(store.status).font(.monoSmall).foregroundStyle(store.failed ? Ink.stuck : Ink.dim)
                    }
                    Text("Restore puts back any card swiped off the lock screen. Reinstalling the app invalidates its push tokens; opening it once re-pairs.")
                        .font(.monoSmall).foregroundStyle(Ink.faint)
                    if !ActivityAuthorizationInfo().areActivitiesEnabled {
                        Button {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        } label: { Pill(label: "live activities are off: open iOS settings", filled: Ink.stuck) }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 20)
            }
        }
        .preferredColorScheme(.dark)
    }
}

#Preview {
    ContentView()
}
