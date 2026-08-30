import ActivityKit
import SwiftUI
import WidgetKit

// MARK: - Content state, read as presentation

private enum Template: String {
    case progress
    case needsYou = "needs_you"
    case result
    case countdown

    /// Unknown template strings fall back to progress. Never render blank.
    init(_ raw: String) { self = Template(rawValue: raw) ?? .progress }
}

/// Approved literals from the m1 variant. These are design tokens, not semantic colors:
/// the card ground is pinned to pure black, so there is no light appearance to adapt to
/// and a semantic color would only drift away from what was signed off.
private enum Tone: String {
    case neutral, warn, ok, fail

    init(_ raw: String) { self = Tone(rawValue: raw) ?? .neutral }

    // Colour-blind safe set (decided 2026-08-29; he is colour-blind): Okabe-Ito hues,
    // lifted for OLED black. Every pair differs in lightness as well as hue, so
    // red/green and blue/yellow confusions still leave the states apart. The
    // text carries the meaning regardless: "done"/"failed" in the trailing slot,
    // "no output for Nm" when stuck, the question when asking.
    var color: Color {
        switch self {
        case .neutral: Color(red: 0.74, green: 0.79, blue: 0.86)
        case .warn: Color(red: 0.92, green: 0.42, blue: 0.05)  // vermilion: stuck
        case .ok: Color(red: 0.10, green: 0.78, blue: 0.58)    // bluish green: done
        case .fail: Color(red: 0.88, green: 0.48, blue: 0.75)  // reddish purple: failed
        }
    }

    var isNeutral: Bool { self == .neutral }

    /// needs_you's own accent, decided 2026-08-29. It used to borrow warn's orange,
    /// so "your turn" looked like a fault and was indistinguishable from "stuck".
    /// A cool periwinkle on black reads as a message light, not an alarm, and is
    /// the only cool hue on the card, so it cannot be confused with any tone.
    static let ask = Color(red: 0.40, green: 0.72, blue: 0.96) // sky blue: asking

    /// A working session's own colour, decided 2026-08-29: a healthy progress card
    /// used to glow the same dim white as a parked loop's countdown, so "thinking"
    /// and "asleep until the next check" looked identical. Teal is alive without
    /// being green's "done"; the countdown keeps the dim white of something resting.
    static let working = Color(red: 0.96, green: 0.86, blue: 0.28) // yellow: working
}

/// The single thing the trailing slot carries. Exactly one, never two, sometimes none.
/// Never a percent: the bar already says how far along it is.
private enum Trailing {
    case blank
    case clock(Date)
    case word(String)
}

private extension AgentActivity.ContentState {
    var template_: Template { Template(template) }
    var tone_: Tone { Tone(tone) }

    /// Only a lane blocked on him is loud, and loud means a brighter rim and bloom.
    var loud: Bool { template_ == .needsYou }

    /// The one color this card wears: needs_you always the ask accent, whatever
    /// tone the server sent; everything else its tone.
    var accent: Color { loud ? Tone.ask : working ? Tone.working : tone_.color }
    var toned: Bool { loud || working || !tone_.isNeutral }

    /// A healthy progress card: busy, not stuck (stuck is warn), not a countdown.
    var working: Bool { template_ == .progress && tone_.isNeutral }

    /// Tapping the card opens this. The server already restricts it to https on an
    /// allowlisted host, but parse defensively: a bad string here must mean "not
    /// tappable", never a crash inside the widget process.
    var link: URL? {
        // The server allowlists the host and the claude://code/<id> shape, so accept
        // both: https://claude.ai/... and claude://code/<id>. A bad string means
        // "not tappable", never a crash in the widget process.
        guard let url, let u = URL(string: url), u.scheme == "https" || u.scheme == "claude"
        else { return nil }
        return u
    }

    /// countdown -> time left; result -> the verdict; everything else -> elapsed.
    var trailing: Trailing {
        if template_ == .countdown, let deadline { return .clock(deadline) }
        if template_ == .result { return .word(tone_ == .fail ? "failed" : "done") }
        if let startedAt { return .clock(startedAt) }
        return .blank
    }

    /// Non-nil only for the progress template. No bar when there is nothing to show.
    var bar: Double? {
        guard template_ == .progress, let progress else { return nil }
        return min(max(progress, 0), 1)
    }

    /// A neutral lane reads as dimmed white; a toned one wears its own color, full
    /// strength when loud.
    var laneColor: Color {
        toned ? accent.opacity(loud ? 1.0 : 0.85) : Color.white.opacity(0.50)
    }

    /// The bloom and rim hue. A quiet neutral card glows white, not blue-grey.
    var hue: Color { toned ? accent : .white }
}

// MARK: - Type

private extension Font {
    /// New York. Ships with iOS, nothing bundled.
    static let ledgeMessage = Font.system(size: 15, weight: .regular, design: .serif)
    static let ledgeLane = Font.system(size: 9, weight: .medium, design: .monospaced)
    static let ledgeTrail = Font.system(size: 9.5, weight: .medium, design: .monospaced)
}

// MARK: - Card

/// Between a bare hairline and a full edge glow: a soft bloom hugging the top edge, a
/// whisper of sheen, no horizon cut. Every opacity below is the reference value already
/// multiplied by k = 0.60, the variant Abhay approved.
private struct Slab: View {
    let hue: Color
    let loud: Bool

    var body: some View {
        let r = RoundedRectangle(cornerRadius: 22, style: .continuous)
        ZStack {
            r.fill(.black)

            // Sheen falling off the top edge.
            r.fill(LinearGradient(
                stops: [
                    .init(color: .white.opacity(0.078), location: 0.00),
                    .init(color: .white.opacity(0.024), location: 0.13),
                    .init(color: .white.opacity(0.0072), location: 0.34),
                    .init(color: .clear, location: 0.62),
                ],
                startPoint: .top,
                endPoint: .bottom
            ))

            // Tone bloom, centred just above the top edge.
            r.fill(RadialGradient(
                colors: [hue.opacity(loud ? 0.18 : 0.06), .clear],
                center: .init(x: 0.5, y: -0.08),
                startRadius: 1,
                endRadius: 150
            ))

            r.strokeBorder(
                LinearGradient(
                    stops: [
                        .init(color: hue.opacity(loud ? 0.6555 : 0.3588), location: 0.00),
                        .init(color: .white.opacity(0.05), location: 0.26),
                        .init(color: .white.opacity(0.035), location: 1.00),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                ),
                lineWidth: 0.8
            )
        }
    }
}

private struct ToneBar: View {
    let value: Double
    let tone: Color

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.07))
                Capsule().fill(tone.opacity(0.85)).frame(width: geo.size.width * value)
            }
        }
        .frame(height: 2)
        .padding(.top, 3)
    }
}

/// iOS ticks .timer for free, counting down to a future date and up from a past one.
/// Never push an update just to advance a clock.
private struct TrailingValue: View {
    let state: AgentActivity.ContentState
    var font: Font = .ledgeTrail
    var opacity: Double = 0.42

    var body: some View {
        switch state.trailing {
        case .blank:
            EmptyView()
        case .clock(let date):
            Text(date, style: .timer)
                .font(font)
                .foregroundStyle(Color.white.opacity(opacity))
                .lineLimit(1)
        case .word(let word):
            Text(word)
                .font(font)
                .foregroundStyle(Color.white.opacity(opacity))
                .lineLimit(1)
        }
    }
}

private struct Row: View {
    let lane: String
    let state: AgentActivity.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 0) {
                Text(lane)
                    .font(.ledgeLane)
                    .foregroundStyle(state.laneColor)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer()

                TrailingValue(state: state)
            }

            Text(state.line)
                .font(.ledgeMessage)
                .foregroundStyle(.white)
                .lineLimit(1)
                .truncationMode(.tail)

            if let bar = state.bar {
                ToneBar(value: bar, tone: state.accent)
            }
        }
    }
}

// MARK: - Widget

struct LedgeLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentActivity.self) { context in
            Row(lane: context.laneLabel, state: context.state)
                .padding(.horizontal, 15)
                .padding(.vertical, 13)
                .background(Slab(hue: context.state.hue, loud: context.state.loud))
                .activityBackgroundTint(.black)
                .activitySystemActionForegroundColor(.white)
                .widgetURL(context.state.link ?? URL(string: "ledge://lane/\(context.attributes.lane)"))
        } dynamicIsland: { context in
            // One link for every presentation. The expanded island had none, so a
            // tap there opened Ledge bare instead of the session (2026-08-29).
            let link = context.state.link ?? URL(string: "ledge://lane/\(context.attributes.lane)")
            return DynamicIsland {
                // The wings around the sensor are too narrow for a lane name and a
                // clock to sit in, and the message then floats centered beneath them.
                // Use the bottom region alone and lay it out exactly like the card:
                // lane and trailing value on one row, the message under them, left-aligned.
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 0) {
                            Text(context.laneLabel)
                                .font(.system(size: 10, weight: .medium, design: .monospaced))
                                .foregroundStyle(context.state.laneColor)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Spacer(minLength: 8)
                            TrailingValue(
                                state: context.state,
                                font: .system(size: 10, weight: .medium, design: .monospaced),
                                opacity: 0.55
                            )
                        }
                        Text(context.state.line)
                            .font(.system(size: 16, weight: .regular, design: .serif))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if let bar = context.state.bar {
                            ToneBar(value: bar, tone: context.state.accent)
                        }
                    }
                    .padding(.horizontal, 6)
                    .padding(.top, 4)
                    .padding(.bottom, 2)
                }
            } compactLeading: {
                ToneEdge(color: context.state.accent)
                    .widgetURL(link)
            } compactTrailing: {
                TrailingValue(
                    state: context.state,
                    font: .system(size: 12, weight: .medium, design: .monospaced),
                    opacity: 0.55
                )
                .frame(maxWidth: 52)
                .widgetURL(link)
            } minimal: {
                ToneEdge(color: context.state.accent)
                    .widgetURL(link)
            }
            .widgetURL(link)
        }
    }
}

/// The card rim, shrunk to fit the island. The tone color is the information, so this
/// never becomes a logo.
private struct ToneEdge: View {
    let color: Color

    var body: some View {
        Capsule()
            .fill(color)
            .frame(width: 3, height: 11)
    }
}

private extension ActivityViewContext<AgentActivity> {
    /// `title` is the per-update label the server truncates to 32 chars; `lane` is the
    /// fixed routing key it falls back to. In practice they are the same string.
    var laneLabel: String {
        state.title.isEmpty ? attributes.lane : state.title
    }
}

// MARK: - Canvas

// The approved m1 deck, so the look can be judged without a device.
// Stripped from release builds.
private extension AgentActivity.ContentState {
    static let running = AgentActivity.ContentState(
        template: "progress",
        title: "networking",
        line: "drafting 3 outreach emails",
        progress: 0.42,
        startedAt: .now.addingTimeInterval(-720),
        deadline: nil,
        tone: "neutral"
    )

    static let ticking = AgentActivity.ContentState(
        template: "countdown",
        title: "phd",
        line: "UW Madison deadline",
        progress: nil,
        startedAt: nil,
        deadline: .now.addingTimeInterval(10781),
        tone: "neutral"
    )

    static let done = AgentActivity.ContentState(
        template: "result",
        title: "brain",
        line: "vault synced, 2 notes captured",
        progress: nil,
        startedAt: .now.addingTimeInterval(-1240),
        deadline: nil,
        tone: "ok"
    )

    static let blocked = AgentActivity.ContentState(
        template: "needs_you",
        title: "projects",
        line: "approve the outreach draft?",
        progress: nil,
        startedAt: .now.addingTimeInterval(-240),
        deadline: nil,
        tone: "warn"
    )

    static let broke = AgentActivity.ContentState(
        template: "result",
        title: "projects",
        line: "tests.R exited 1 on stage 03",
        progress: nil,
        startedAt: .now.addingTimeInterval(-60),
        deadline: nil,
        tone: "fail"
    )
}

#Preview("Lock screen", as: .content, using: AgentActivity(lane: "networking")) {
    LedgeLiveActivity()
} contentStates: {
    AgentActivity.ContentState.running
    AgentActivity.ContentState.ticking
    AgentActivity.ContentState.done
    AgentActivity.ContentState.blocked
    AgentActivity.ContentState.broke
}

#Preview("Island expanded", as: .dynamicIsland(.expanded), using: AgentActivity(lane: "networking")) {
    LedgeLiveActivity()
} contentStates: {
    AgentActivity.ContentState.running
    AgentActivity.ContentState.blocked
    AgentActivity.ContentState.broke
}

#Preview("Island compact", as: .dynamicIsland(.compact), using: AgentActivity(lane: "networking")) {
    LedgeLiveActivity()
} contentStates: {
    AgentActivity.ContentState.running
    AgentActivity.ContentState.blocked
    AgentActivity.ContentState.broke
}
