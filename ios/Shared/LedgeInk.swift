import SwiftUI

/// The card's language, in one place. Was a private copy inside ContentView, kept
/// in step with the widget's by hand; the notification extension would have made
/// that three copies, so the app and the extension share this one.
///
/// Colour-blind safe (Okabe-Ito hues lifted for OLED black): every pair differs in
/// lightness as well as hue, and the word and the glyph each carry the state on
/// their own, so nothing here depends on hue being read.
enum Ink {
    static let ask = Color(red: 0.40, green: 0.72, blue: 0.96)
    static let working = Color(red: 0.88, green: 0.89, blue: 0.92)
    static let stuck = Color(red: 0.92, green: 0.42, blue: 0.05)
    static let done = Color(red: 0.10, green: 0.78, blue: 0.58)
    static let failed = Color(red: 0.88, green: 0.48, blue: 0.75)
    static let dim = Color.white.opacity(0.42)
    static let faint = Color.white.opacity(0.22)

    static func of(_ s: CardState) -> Color {
        switch s {
        case .working: working
        case .asking, .approval: ask
        case .stuck: stuck
        case .resting, .idle: dim
        case .done: done
        case .failed: failed
        }
    }

    static func word(_ s: CardState) -> String {
        switch s {
        case .working: "working"
        case .asking: "needs input"
        case .approval: "approve?"
        case .stuck: "stuck"
        case .resting: "resting"
        case .idle: "idle"
        case .done: "ready for review"
        case .failed: "failed"
        }
    }
}

/// The eight marks, the third channel alongside hue and the word. Silhouette, not
/// decoration: three dots, a question mark, a hand, a triangle, a crescent, two
/// bars, a check, an octagon, all separable in greyscale.
extension CardState {
    var mark: String {
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
