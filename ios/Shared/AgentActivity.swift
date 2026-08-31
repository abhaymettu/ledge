import ActivityKit
import AppIntents
import Foundation
import WidgetKit

/// The one thing a card is. Mirrors server/card-state.mts.
enum CardState: String, Codable, Hashable {
    case working, asking, approval, stuck, resting, idle, done, failed

    /// A state this build does not know (a newer server) renders as working, never blank.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CardState(rawValue: raw) ?? .working
    }
}

struct AgentActivity: ActivityAttributes {
    var lane: String
    struct ContentState: Codable, Hashable {
        var state: CardState
        /// The identity. Stable for the life of the session, never the summarised
        /// title, so a card can be tracked across glances.
        var title: String
        /// Kept for builds that predate `headline`. Same text the headline carries.
        var line: String
        /// The act. Optional: a server that does not send it leaves `line` to
        /// carry the row, the way an unknown state decodes as .working.
        var headline: String?
        /// One line under the act. Optional in the same way.
        var subline: String?
        var progress: Double?
        var startedAt: Date?
        var deadline: Date?
        var url: String?
        var approvalId: String?
        /// Why the last tap on Allow or Deny did not land. Written locally by the
        /// intent, never by the server, and cleared by the next push.
        var decideError: String?
    }
}

/// Allow or deny a permission request from the lock screen or the island. A
/// LiveActivityIntent runs in the app's process, so the app's stored server URL
/// and token are at hand without an app group.
struct DecideIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Decide"
    static let isDiscoverable = false

    @Parameter(title: "Approval") var approvalId: String
    @Parameter(title: "Decision") var decision: String

    init() {}
    init(approvalId: String, decision: String) {
        self.approvalId = approvalId
        self.decision = decision
    }

    func perform() async throws -> some IntentResult {
        await LedgeDecision.record(await decideApproval(approvalId, decision), for: approvalId)
        return .result()
    }
}

/// Putting the answer back on the phone. A card only redraws when something
/// writes to it, so a failure has to be written onto the activity itself; the
/// group copy is for the home widget, which redraws from its own timeline.
enum LedgeDecision {
    static func record(_ outcome: DecideOutcome, for approvalId: String) async {
        var failures = LedgeGroup.decideFailures
        failures[approvalId] = outcome.line
        // One id per approval and approvals are short-lived, so this would grow
        // without bound. Keep only what a card can still be showing.
        if failures.count > 16 { failures = failures.filter { $0.key == approvalId } }
        LedgeGroup.decideFailures = failures

        for activity in Activity<AgentActivity>.activities
        where activity.content.state.approvalId == approvalId {
            var state = activity.content.state
            state.decideError = outcome.line
            await activity.update(ActivityContent(state: state, staleDate: nil))
        }
        WidgetCenter.shared.reloadAllTimelines()
    }
}
