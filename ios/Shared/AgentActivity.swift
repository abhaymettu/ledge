import ActivityKit
import Foundation

struct AgentActivity: ActivityAttributes {
    var lane: String                  // "networking", fixed at start, never changes
    struct ContentState: Codable, Hashable {
        var template: String          // progress | needs_you | result | countdown
        var title: String             // <= 32 chars, the session title
        var line: String              // <= 60 chars, e.g. "drafting 3 outreach emails"
        var progress: Double?         // 0...1, progress template only
        var startedAt: Date?          // progress: drives the elapsed timer
        var deadline: Date?           // countdown: drives the ticking timer
        var tone: String              // neutral | warn | ok | fail
        var url: String?              // https://claude.ai/... tapping the card opens it
    }
}
