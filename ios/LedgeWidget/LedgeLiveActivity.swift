import ActivityKit
import SwiftUI
import WidgetKit

// MARK: - Content state, read as presentation

/// Colour-blind safe set (Okabe-Ito hues lifted for OLED black): every pair differs
/// in lightness as well as hue, and the text carries the state on its own.
///
/// working is deliberately achromatic. It was Okabe-Ito yellow, which parts from the
/// vermillion of stuck mostly in the green channel, the one a red-green eye reads
/// weakest, so the two states blurred into each other. Spending no hue on the ambient
/// state also leaves every hue for the states that want attention. The cost: resting
/// and idle have to sit well below it in lightness, or the two neutrals collide.
private extension CardState {
    var color: Color {
        switch self {
        case .working: Color(red: 0.88, green: 0.89, blue: 0.92)
        case .asking, .approval: Color(red: 0.40, green: 0.72, blue: 0.96)
        case .stuck: Color(red: 0.92, green: 0.42, blue: 0.05)
        case .resting, .idle: Color.white.opacity(0.45)
        case .done: Color(red: 0.10, green: 0.78, blue: 0.58)
        case .failed: Color(red: 0.88, green: 0.48, blue: 0.75)
        }
    }
}

/// The third channel, alongside hue and the word. The palette above is Okabe-Ito
/// because Abhay is colour-blind, and the comment there already leans on the text
/// carrying the state on its own. A glyph carries it a second way, so a state is
/// legible when hue is stripped entirely.
///
/// Chosen for silhouette, not for cuteness: three dots, a question mark, a hand, a
/// triangle, a crescent, two bars, a check, an octagon. Rendered greyscale and
/// compared pairwise, the closest pair (resting against failed, both round) sits at
/// 0.447 correlation, well inside the 0.5 bar.
private extension CardState {
    var glyph: String {
        switch self {
        case .working: "ellipsis"
        case .asking: "questionmark"
        case .approval: "hand.raised"
        case .stuck: "exclamationmark.triangle"
        case .resting: "moon"
        case .idle: "pause"
        case .done: "checkmark"
        case .failed: "xmark.octagon"
        }
    }
}

/// The single thing the trailing slot carries. Exactly one, never two, sometimes none.
/// Never a percent: the bar already says how far along it is.
private enum Trailing {
    case blank
    case clock(Date)
    case word(String)
}

private extension AgentActivity.ContentState {
    /// Only a card asking for him is loud: a brighter rim and bloom.
    var loud: Bool { state == .asking || state == .approval }

    var accent: Color { state.color }

    /// A resting card glows white at rest; every other state wears its colour.
    var toned: Bool { state != .resting && state != .idle }

    /// A bad string means "not tappable", never a crash inside the widget process.
    var link: URL? {
        guard let url, let u = URL(string: url), u.scheme == "https" || u.scheme == "claude"
        else { return nil }
        return u
    }

    var trailing: Trailing {
        switch state {
        case .resting: deadline.map(Trailing.clock) ?? startedAt.map(Trailing.clock) ?? .blank
        case .done: .word("ready for review")
        case .failed: .word("failed")
        case .working, .asking, .approval, .stuck, .idle: startedAt.map(Trailing.clock) ?? .blank
        }
    }

    var bar: Double? {
        guard state == .working || state == .stuck, let progress else { return nil }
        return min(max(progress, 0), 1)
    }

    var laneColor: Color {
        toned ? accent.opacity(loud ? 1.0 : 0.85) : Color.white.opacity(0.50)
    }

    var hue: Color { toned ? accent : .white }

    /// The act. A server without `headline` leaves `line` to do the job it does today.
    var act: String { headline.map { $0.isEmpty ? line : $0 } ?? line }

    /// The detail under the act, when there is one worth a row.
    var detail: String? {
        guard let subline, !subline.isEmpty else { return nil }
        return subline
    }
}

// MARK: - Type

private extension Font {
    /// New York. Ships with iOS, nothing bundled.
    static let ledgeMessage = Font.system(size: 15, weight: .regular, design: .serif)
    static let ledgeLane = Font.system(size: 9, weight: .medium, design: .monospaced)
    static let ledgeTrail = Font.system(size: 9.5, weight: .medium, design: .monospaced)
    static let ledgeSub = Font.system(size: 9.5, weight: .regular, design: .monospaced)
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
            // A timer reserves the width of its longest possible value and would
            // squeeze the title beside a box of dead space; cap it and align right.
            Text(date, style: .timer)
                .font(font)
                .foregroundStyle(Color.white.opacity(opacity))
                .lineLimit(1)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 58, alignment: .trailing)
        case .word(let word):
            Text(word)
                .font(font)
                .foregroundStyle(Color.white.opacity(opacity))
                .lineLimit(1)
        }
    }
}

/// The glyph as a leading mark on the identity row. Sized to the mono label beside
/// it, never larger: the serif headline underneath is what the eye should land on.
private struct StateMark: View {
    let state: CardState
    let tint: Color

    var body: some View {
        Image(systemName: state.glyph)
            .font(.system(size: 9, weight: .semibold))
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(tint)
            .frame(width: 11, alignment: .leading)
            .accessibilityLabel(String(describing: state))
    }
}

private struct Row: View {
    let lane: String
    let state: AgentActivity.ContentState

    var body: some View {
        // Identity on top and still, act underneath and moving. The stillness of
        // the first row is what makes the second readable; nothing else here is
        // allowed to move.
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                StateMark(state: state.state, tint: state.laneColor)

                Text(lane)
                    .font(.ledgeLane)
                    .foregroundStyle(state.laneColor)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(1)

                Spacer(minLength: 8)

                TrailingValue(state: state)
            }

            // Serif 15 fits 35 narrow characters on the smallest card and the
            // validator lets 60 through, so the act has to squeeze before it cuts.
            // Measured: the longest realistic headline is 402pt into a 329pt slot,
            // which 0.75 covers. Only a synthetic 60 character line still clips.
            // With no detail under it the act takes that row too rather than
            // leaving the card short: two lines of what happened beats one line
            // and a gap.
            Text(state.act)
                .font(.ledgeMessage)
                .foregroundStyle(.white)
                .lineLimit(state.detail == nil ? 2 : 1)
                .minimumScaleFactor(0.75)
                .truncationMode(.tail)

            if let detail = state.detail {
                Text(detail)
                    .font(.ledgeSub)
                    .foregroundStyle(.white.opacity(0.45))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .truncationMode(.tail)
            }

            if state.state == .approval, let id = state.approvalId {
                DecideRow(approvalId: id, accent: state.accent, error: state.decideError)
            }

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
                        HStack(spacing: 5) {
                            StateMark(state: context.state.state, tint: context.state.laneColor)
                            Text(context.laneLabel)
                                .font(.system(size: 10, weight: .medium, design: .monospaced))
                                .foregroundStyle(context.state.laneColor)
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .layoutPriority(1)
                            Spacer(minLength: 8)
                            TrailingValue(
                                state: context.state,
                                font: .system(size: 10, weight: .medium, design: .monospaced),
                                opacity: 0.55
                            )
                        }
                        Text(context.state.act)
                            .font(.system(size: 16, weight: .regular, design: .serif))
                            .foregroundStyle(.white)
                            .lineLimit(context.state.detail == nil ? 2 : 1)
                            .minimumScaleFactor(0.7)
                            .truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if let detail = context.state.detail {
                            Text(detail)
                                .font(.system(size: 10, weight: .regular, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.45))
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if let bar = context.state.bar {
                            ToneBar(value: bar, tone: context.state.accent)
                        }
                        if context.state.state == .approval, let id = context.state.approvalId {
                            DecideRow(approvalId: id, accent: context.state.accent, error: context.state.decideError)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 6)
                    .padding(.top, 4)
                    .padding(.bottom, 2)
                }
            } compactLeading: {
                // A card that does not need him shows nothing in the compact island, so an
                // occupied island means "act now" (decided 2026-08-29). It still expands.
                //
                // ToneEdge over the glyph here, deliberately. Only two states are ever
                // loud, asking and approval, and both share one hue, so a glyph would be
                // spending detail on a distinction the compact island never has to make.
                // The bar reads as pure alarm at 3pt wide; the glyph reads as an icon.
                // The expanded region is where the two states separate, and that is where
                // the glyph earns its place. Preview both in the Canvas deck below.
                if context.state.loud {
                    ToneEdge(color: context.state.accent)
                        .widgetURL(link)
                }
            } compactTrailing: {
                if context.state.loud {
                    TrailingValue(
                        state: context.state,
                        font: .system(size: 12, weight: .medium, design: .monospaced),
                        opacity: 0.55
                    )
                    .frame(maxWidth: 52)
                    .widgetURL(link)
                }
            } minimal: {
                if context.state.loud {
                    ToneEdge(color: context.state.accent)
                        .widgetURL(link)
                }
            }
            .widgetURL(link)
        }
    }
}

/// Allow and Deny, only on an approval card. The only interactive thing on the card.
private struct DecideRow: View {
    let approvalId: String
    let accent: Color
    /// Why the last tap did not land. The buttons stay under it: every one of these
    /// is worth a second try once the phone can reach the Mac again.
    var error: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let error {
                // Words and a glyph, never a colour on its own: the reason has to
                // survive a greyscale reading, and "it failed" would not say what
                // to do about it.
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.75))
                    .lineLimit(2)
            }
            buttons
        }
        .padding(.top, 4)
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            Button(intent: DecideIntent(approvalId: approvalId, decision: "deny")) {
                Text("Deny")
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.8))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(.white.opacity(0.10)))
            }
            .buttonStyle(.plain)
            Button(intent: DecideIntent(approvalId: approvalId, decision: "allow")) {
                Text("Allow")
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.black)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(accent))
            }
            .buttonStyle(.plain)
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
        state.title.isEmpty ? attributes.lane.replacingOccurrences(of: "cc-", with: "") : state.title
    }
}

// MARK: - Canvas

// All eight states, each with the identity it keeps, the act it is doing, and the
// detail under it. This is how the look gets reviewed, so every state the server
// can produce is here, plus the two edge cases that decide whether the layout
// holds: a card from a server too old to send a headline, and the longest text
// the validator will ever let through.
//
// Stripped from release builds.
private extension AgentActivity.ContentState {
    static let running = AgentActivity.ContentState(
        state: .working, title: "Lock screen agent", line: "editing LedgeLiveActivity.swift",
        headline: "editing LedgeLiveActivity.swift, the trailing slot and the act row",
        progress: 0.42, startedAt: .now.addingTimeInterval(-720))

    static let waiting = AgentActivity.ContentState(
        state: .asking, title: "Tesla resume pass", line: "which resume variant for Tesla?",
        headline: "which resume variant for Tesla?", subline: "asked 2:14 pm",
        startedAt: .now.addingTimeInterval(-960))

    static let permission = AgentActivity.ContentState(
        state: .approval, title: "Kalshi dead pool", line: "allow: rm -rf build",
        headline: "allow: rm -rf build", subline: "Bash in memecoin-edge",
        startedAt: .now.addingTimeInterval(-40), approvalId: "preview")

    static let silent = AgentActivity.ContentState(
        state: .stuck, title: "Numen blind audit", line: "no output for 11m",
        headline: "no output for 11m", subline: "running tests.py",
        startedAt: .now.addingTimeInterval(-1_020))

    static let ticking = AgentActivity.ContentState(
        state: .resting, title: "UW Madison packet", line: "rate limit, wakes itself",
        headline: "rate limit, wakes itself", subline: "wakes 4:30 pm",
        deadline: .now.addingTimeInterval(10781))

    static let quiet = AgentActivity.ContentState(
        state: .idle, title: "Vault capture sweep", line: "captured 4 notes, vault synced",
        headline: "captured 4 notes, vault synced",
        startedAt: .now.addingTimeInterval(-2_400))

    /// What the poller actually sends when a session goes away: the last act it
    /// was on, and how long that state had run. No invented outcome.
    static let finished = AgentActivity.ContentState(
        state: .done, title: "Catalog nightly build", line: "catalog rebuilt, 1084 entries",
        headline: "catalog rebuilt, 1084 entries", subline: "working for 2h 14m",
        startedAt: .now.addingTimeInterval(-8_040))

    /// The one ending that is genuinely an outcome: it vanished mid question and
    /// he never answered.
    static let abandoned = AgentActivity.ContentState(
        state: .done, title: "Tesla resume pass", line: "which resume variant for Tesla?",
        headline: "closed while waiting on you", subline: "41m unanswered",
        startedAt: .now.addingTimeInterval(-2_460))

    /// failed is unreachable from the poller, which has no failure signal, so
    /// this shape only arrives if something else ever posts to /activity/end
    /// with tone fail. Previewed because the state exists, not because anything
    /// sends it today.
    static let broke = AgentActivity.ContentState(
        state: .failed, title: "Margin variance rerun", line: "tests.R exited 1 on stage 03",
        headline: "tests.R exited 1 on stage 03", subline: "01_audit.R line 42",
        startedAt: .now.addingTimeInterval(-60))

    /// Two things at once: a server too old to send a headline, so `line` carries
    /// the row alone and the subline vanishes, and a session too young to have a
    /// title, so the cwd basename is still holding the identity row.
    static let legacy = AgentActivity.ContentState(
        state: .working, title: "ledge", line: "editing card.mts",
        startedAt: .now.addingTimeInterval(-300))

    /// Both fields at the validator's 60 character cap, which is the worst the
    /// smallest card will ever be asked to lay out.
    static let longest = AgentActivity.ContentState(
        state: .working, title: "Paper widget rebuild",
        line: String(repeating: "n", count: 60),
        headline: "regenerating the catalog from four upstream sources now",
        subline: "~/Desktop/Playground/scriptable-widgets/lib/paper.js",
        startedAt: .now.addingTimeInterval(-180))
}

#Preview("Lock screen, eight states", as: .content, using: AgentActivity(lane: "cc-ledge")) {
    LedgeLiveActivity()
} contentStates: {
    AgentActivity.ContentState.running
    AgentActivity.ContentState.waiting
    AgentActivity.ContentState.permission
    AgentActivity.ContentState.silent
    AgentActivity.ContentState.ticking
    AgentActivity.ContentState.quiet
    AgentActivity.ContentState.finished
    AgentActivity.ContentState.abandoned
    AgentActivity.ContentState.broke
}

#Preview("Lock screen, edges", as: .content, using: AgentActivity(lane: "cc-ledge")) {
    LedgeLiveActivity()
} contentStates: {
    AgentActivity.ContentState.legacy
    AgentActivity.ContentState.longest
}

#Preview("Island expanded", as: .dynamicIsland(.expanded), using: AgentActivity(lane: "cc-ledge")) {
    LedgeLiveActivity()
} contentStates: {
    AgentActivity.ContentState.running
    AgentActivity.ContentState.waiting
    AgentActivity.ContentState.permission
    AgentActivity.ContentState.silent
    AgentActivity.ContentState.ticking
    AgentActivity.ContentState.quiet
    AgentActivity.ContentState.finished
    AgentActivity.ContentState.broke
    AgentActivity.ContentState.longest
}

#Preview("Island compact", as: .dynamicIsland(.compact), using: AgentActivity(lane: "cc-ledge")) {
    LedgeLiveActivity()
} contentStates: {
    AgentActivity.ContentState.running
    AgentActivity.ContentState.waiting
    AgentActivity.ContentState.permission
}

#Preview("Island minimal", as: .dynamicIsland(.minimal), using: AgentActivity(lane: "cc-ledge")) {
    LedgeLiveActivity()
} contentStates: {
    AgentActivity.ContentState.waiting
    AgentActivity.ContentState.permission
    AgentActivity.ContentState.running
}
