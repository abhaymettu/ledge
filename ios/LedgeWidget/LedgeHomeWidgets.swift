import AppIntents
import SwiftUI
import WidgetKit

struct FleetConfig: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Ledge"
}

// MARK: - Data

struct FleetEntry: TimelineEntry {
    let date: Date
    let snapshot: LedgeSnapshot?
    let stale: Bool

    var approvals: [LedgeApproval] { snapshot?.approvals ?? [] }
    /// Read at draw time rather than carried in the snapshot: the intent writes it
    /// after the snapshot was built, and reloads the timeline to get us back here.
    var decideFailures: [String: String] { LedgeGroup.decideFailures }
    var cards: [(lane: String, card: AgentActivity.ContentState)] {
        (snapshot?.lanes ?? [:]).map { ($0.key, $0.value) }.sorted { a, b in
            let ra = rank(a.card.state), rb = rank(b.card.state)
            return ra != rb ? ra < rb : (a.card.startedAt ?? .distantPast) > (b.card.startedAt ?? .distantPast)
        }
    }
    var needsYou: [(lane: String, card: AgentActivity.ContentState)] { cards.filter { $0.card.state == .asking || $0.card.state == .approval } }
    var doneToday: Int {
        let start = Calendar.current.startOfDay(for: date).timeIntervalSince1970
        var seen = Set<String>()
        return (snapshot?.history ?? []).filter { $0.endedAt / 1000 >= start && seen.insert($0.lane).inserted }.count
    }

    private func rank(_ s: CardState) -> Int {
        switch s {
        case .approval: 0
        case .asking: 1
        case .stuck: 2
        case .working: 3
        case .resting: 4
        case .idle: 5
        case .done, .failed: 6
        }
    }
}

struct FleetProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> FleetEntry { FleetEntry(date: .now, snapshot: nil, stale: false) }

    func snapshot(for configuration: FleetConfig, in context: Context) async -> FleetEntry {
        FleetEntry(date: .now, snapshot: LedgeSnapshot.cached, stale: false)
    }

    func timeline(for configuration: FleetConfig, in context: Context) async -> Timeline<FleetEntry> {
        let fresh = await LedgeSnapshot.fetch()
        let entry = FleetEntry(date: .now, snapshot: fresh ?? LedgeSnapshot.cached, stale: fresh == nil)
        return Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60)))
    }
}

// MARK: - Look: the card's language on the home screen

private extension CardState {
    var color: Color {
        switch self {
        case .working: Color(red: 0.88, green: 0.89, blue: 0.92)
        case .asking, .approval: Color(red: 0.40, green: 0.72, blue: 0.96)
        case .stuck: Color(red: 0.92, green: 0.42, blue: 0.05)
        case .resting, .idle: Color.white.opacity(0.5)
        case .done: Color(red: 0.10, green: 0.78, blue: 0.58)
        case .failed: Color(red: 0.88, green: 0.48, blue: 0.75)
        }
    }
}

private let mono = Font.system(size: 10, weight: .medium, design: .monospaced)
private let serif = Font.system(size: 15, weight: .regular, design: .serif)
private let big = Font.system(size: 40, weight: .regular, design: .serif)
private let inbox = URL(string: "ledge://inbox")!

private struct Elapsed: View {
    let date: Date?
    var body: some View {
        if let date {
            Text(date, style: .timer)
                .font(mono)
                .foregroundStyle(.white.opacity(0.42))
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 58, alignment: .trailing)
        }
    }
}

// MARK: - Medium: does anything need me?

struct NeedsYouWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "ledge.needsyou", intent: FleetConfig.self, provider: FleetProvider()) { entry in
            NeedsYouView(entry: entry)
                .containerBackground(.black, for: .widget)
                .widgetURL(inbox)
        }
        .configurationDisplayName("Needs you")
        .description("How many sessions are waiting on you, and the one that has waited longest.")
        .supportedFamilies([.systemMedium])
        .contentMarginsDisabled()
    }
}

private struct NeedsYouView: View {
    let entry: FleetEntry

    var body: some View {
        let waiting = entry.needsYou
        let count = waiting.count + entry.approvals.count
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text(count == 0 ? "0" : String(count))
                    .font(big)
                    .foregroundStyle(count == 0 ? .white.opacity(0.35) : Color(red: 0.40, green: 0.72, blue: 0.96))
                Text(count == 0 ? "nothing needs you" : count == 1 ? "needs you" : "need you")
                    .font(mono)
                    .foregroundStyle(.white.opacity(0.5))
                Spacer(minLength: 0)
                Text(entry.snapshot == nil ? "not paired" : entry.stale ? "mac unreachable" : "\(entry.cards.count) running")
                    .font(mono)
                    .foregroundStyle(.white.opacity(0.3))
            }
            .frame(width: 120, alignment: .leading)
            if let top = waiting.first {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 0) {
                        Text(top.card.title).font(mono).foregroundStyle(top.card.state.color).lineLimit(1).layoutPriority(1)
                        Spacer(minLength: 8)
                        Elapsed(date: top.card.startedAt)
                    }
                    Text(top.card.line).font(serif).foregroundStyle(.white).lineLimit(3)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else if let top = entry.cards.first {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 0) {
                        Text(top.card.title).font(mono).foregroundStyle(top.card.state.color).lineLimit(1).layoutPriority(1)
                        Spacer(minLength: 8)
                        Elapsed(date: top.card.startedAt)
                    }
                    Text(top.card.line).font(serif).foregroundStyle(.white.opacity(0.7)).lineLimit(3)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text("No sessions.\nStart one on your Mac.")
                    .font(serif)
                    .foregroundStyle(.white.opacity(0.5))
            }
        }
        .padding(16)
    }
}

// MARK: - Large: the fleet

struct FleetWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "ledge.fleet", intent: FleetConfig.self, provider: FleetProvider()) { entry in
            FleetView(entry: entry)
                .containerBackground(.black, for: .widget)
                .widgetURL(inbox)
        }
        .configurationDisplayName("Fleet")
        .description("Every session: what needs you first, then what is running.")
        .supportedFamilies([.systemLarge])
        .contentMarginsDisabled()
    }
}

private struct FleetView: View {
    let entry: FleetEntry

    var body: some View {
        let approvals = entry.approvals
        let rows = Array(entry.cards.filter { $0.card.state != .approval }.prefix(6 - min(approvals.count, 2)))
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 0) {
                Text("ledge").font(mono).foregroundStyle(.white.opacity(0.5))
                Spacer()
                let n = entry.needsYou.count + approvals.count
                Text(entry.snapshot == nil ? "not paired" : entry.stale ? "mac unreachable" : n == 0 ? "nothing needs you" : "\(n) need you")
                    .font(mono)
                    .foregroundStyle(n == 0 ? .white.opacity(0.35) : Color(red: 0.40, green: 0.72, blue: 0.96))
            }
            ForEach(approvals.prefix(2)) { approval in
                HStack(spacing: 10) {
                    Capsule().fill(CardState.approval.color).frame(width: 3, height: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("allow: \(approval.summary)").font(serif).foregroundStyle(.white).lineLimit(1)
                        // A tap that failed replaces the elapsed clock: how long it
                        // has waited stops being the useful thing the moment the
                        // answer could not get out.
                        if let error = entry.decideFailures[approval.id] {
                            Label(error, systemImage: "exclamationmark.triangle")
                                .font(mono).foregroundStyle(.white.opacity(0.75)).lineLimit(1)
                        } else {
                            Elapsed(date: Date(timeIntervalSince1970: approval.at / 1000))
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .layoutPriority(1)
                    Button(intent: DecideIntent(approvalId: approval.id, decision: "deny")) {
                        Text("Deny").font(mono).foregroundStyle(.white.opacity(0.8))
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(Capsule().fill(.white.opacity(0.10)))
                    }
                    .buttonStyle(.plain)
                    Button(intent: DecideIntent(approvalId: approval.id, decision: "allow")) {
                        Text("Allow").font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(.black)
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(Capsule().fill(CardState.approval.color))
                    }
                    .buttonStyle(.plain)
                }
            }
            ForEach(rows, id: \.lane) { row in
                HStack(spacing: 10) {
                    Capsule().fill(row.card.state.color).frame(width: 3, height: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.card.title).font(mono).foregroundStyle(row.card.state.color).lineLimit(1)
                        Text(row.card.line).font(serif).foregroundStyle(.white).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .layoutPriority(1)
                    Elapsed(date: row.card.state == .resting ? row.card.deadline : row.card.startedAt)
                }
            }
            if approvals.isEmpty && rows.isEmpty {
                Spacer()
                Text("No sessions. Start one on your Mac.").font(serif).foregroundStyle(.white.opacity(0.5))
            }
            Spacer(minLength: 0)
            Text("done today: \(entry.doneToday)").font(mono).foregroundStyle(.white.opacity(0.35))
        }
        .padding(16)
    }
}
