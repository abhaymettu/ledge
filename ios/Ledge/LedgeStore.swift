import ActivityKit
import Foundation
import Observation
import UIKit
import WidgetKit

/// Everything the app does: hold two settings, keep three kinds of token fresh,
/// and say in one line what happened last.
@MainActor
@Observable
final class LedgeStore {
    static let shared = LedgeStore()

    var serverURL: String { didSet { defaults.set(serverURL, forKey: Key.serverURL); LedgeGroup.defaults?.set(serverURL, forKey: Key.serverURL) } }
    var token: String { didSet { defaults.set(token, forKey: Key.token); LedgeGroup.defaults?.set(token, forKey: Key.token) } }
    private(set) var status = ""
    /// Whether the last request failed, so the status line can colour itself.
    private(set) var failed = false
    /// True once /register has succeeded. Persisted so the app opens on the status
    /// screen next launch; start() re-registers anyway and corrects it.
    private(set) var paired: Bool { didSet { defaults.set(paired, forKey: Key.paired) } }

    /// The lane a lock-screen tap pointed at, when the card had no Claude link.
    var focusedLane: String?
    /// True while this app is only a stepping stone to Claude: iOS opens the
    /// card's owning app first, so the frame before Claude appears is ours.
    var handingOff = false
    /// The inbox, read from the Mac: permission requests waiting on him, and what
    /// ended while he was away.
    typealias Approval = LedgeApproval
    typealias Ended = LedgeEnded
    private(set) var approvals: [Approval] = []
    private(set) var history: [Ended] = []

    /// Refresh the inbox. Cheap: two small GETs.
    func refreshInbox() async {
        // A tap on the lock screen runs outside this object, so pick up anything it
        // recorded while the app was away.
        if decideFailures != LedgeGroup.decideFailures { decideFailures = LedgeGroup.decideFailures }
        if let raw = await send("GET", "/approvals")?["approvals"], let data = try? JSONSerialization.data(withJSONObject: raw),
           let list = try? JSONDecoder().decode([Approval].self, from: data), list != approvals { approvals = list }
        if let raw = await send("GET", "/history")?["history"], let data = try? JSONSerialization.data(withJSONObject: raw),
           let list = try? JSONDecoder().decode([Ended].self, from: data), list.reversed() != history { history = list.reversed() }
        let snapshot = LedgeSnapshot(
            lanes: Dictionary(Activity<AgentActivity>.activities.map { ($0.attributes.lane, $0.content.state) }, uniquingKeysWith: { _, newest in newest }),
            approvals: approvals, history: history, at: .now)
        // This runs every five seconds. Reloading the timelines each time spends a
        // budget iOS meters, and once it is spent the home widgets stop updating at
        // all. Compare what the widget actually draws, which means ignoring `at`,
        // since that differs on every pass and would call every pass a change.
        var subject = snapshot
        subject.at = .distantPast
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys  // dictionary order is otherwise arbitrary
        let key = try? encoder.encode(subject)
        guard key != lastWidgetKey else { return }
        lastWidgetKey = key
        snapshot.cache()
        WidgetCenter.shared.reloadAllTimelines()
    }

    private var lastWidgetKey: Data?

    /// Why the last tap on each approval did not land. The same reasons the lock
    /// screen shows, from the same call, so the two surfaces cannot disagree.
    private(set) var decideFailures: [String: String] = LedgeGroup.decideFailures

    /// Goes through `decideApproval` rather than `send`, so the in-app buttons and
    /// the lock-screen buttons are one path. A failure here is never silent.
    func decide(_ approval: Approval, _ decision: String) async {
        let outcome = await decideApproval(approval.id, decision)
        await LedgeDecision.record(outcome, for: approval.id)
        decideFailures = LedgeGroup.decideFailures
        failed = outcome != .ok
        status = outcome.line ?? (decision == "allow" ? "allowed" : "denied")
        if outcome == .ok { approvals.removeAll { $0.id == approval.id } }
    }

    /// True for the first moments after the app becomes active. A card tap delivers
    /// its link only after the first frame is drawn, so without this the status
    /// screen flashes once before the handoff frame. Black until we know why the
    /// app was opened.
    var veiled = true

    /// The veil covers the cold launch only; returning to the app must not flash black.
    func activated() {
        guard veiled else { return }
        Task {
            try? await Task.sleep(for: .milliseconds(400))
            veiled = false
        }
    }
    /// Bumped whenever an activity starts, ends, or changes content, so views that
    /// read `Activity<AgentActivity>.activities` (not observable itself) re-render.
    private(set) var activitiesVersion = 0

    private var pushToStartToken: String?
    private var deviceToken: String?
    private var started = false

    private let defaults = UserDefaults.standard
    private enum Key {
        static let serverURL = "ledge.serverURL"
        static let token = "ledge.token"
        static let paired = "ledge.paired"
    }

    private init() {
        // No baked-in default: the server prints its bind addresses at startup; enter
        // your Mac's tailnet address, e.g. http://100.x.y.z:8787.
        serverURL = defaults.string(forKey: Key.serverURL) ?? ""
        token = defaults.string(forKey: Key.token) ?? ""
        paired = defaults.bool(forKey: Key.paired)
        LedgeGroup.defaults?.set(serverURL, forKey: Key.serverURL)
        LedgeGroup.defaults?.set(token, forKey: Key.token)
    }

    // MARK: - Token lifecycle

    /// Called once per launch. Rebuilding the app invalidates every token, so the app
    /// re-registers on launch and on every update the system hands it, not only on Pair.
    func start() {
        guard !started else { return }
        started = true

        // The device token is what lets the server start a Live Activity remotely.
        // Approvals are answered in the app, reached by tapping the card, so nothing
        // here asks for alert permission any more.
        UIApplication.shared.registerForRemoteNotifications()

        // Push-to-start tokens rotate. This sequence also delivers the current one.
        Task {
            for await data in Activity<AgentActivity>.pushToStartTokenUpdates {
                pushToStartToken = data.hexString
                await register()
            }
        }

        // Every started activity yields its own update token, keyed by lane.
        for activity in Activity<AgentActivity>.activities { observeToken(of: activity) }
        Task {
            for await activity in Activity<AgentActivity>.activityUpdates {
                observeToken(of: activity)
            }
        }
    }

    /// Ids already carrying observer tasks. Three callers reach here for the same
    /// activity (launch, activityUpdates, restore), and a restored one arrives through
    /// two of them. Each extra pass added a second pair of never-ending tasks, so one
    /// push bumped activitiesVersion twice and the inbox rebuilt twice: the flicker,
    /// worse after every restore. Observe an activity once.
    private var observed: Set<String> = []

    private func observeToken(of activity: Activity<AgentActivity>) {
        guard observed.insert(activity.id).inserted else { return }
        let lane = activity.attributes.lane
        let id = activity.id
        activitiesVersion += 1
        Task {
            for await data in activity.pushTokenUpdates {
                await post("/token", ["lane": lane, "updateToken": data.hexString])
            }
        }
        Task { for await _ in activity.contentUpdates { activitiesVersion += 1 } }
        Task {
            for await _ in activity.activityStateUpdates { activitiesVersion += 1 }
            // The sequence ends when the activity does; let the id be observed again
            // if iOS ever hands back one that reuses it.
            observed.remove(id)
        }
    }

    /// Live cards: the one a tap pointed at first, then newest first.
    var activities: [Activity<AgentActivity>] {
        _ = activitiesVersion
        var seen = Set<String>()
        return Activity<AgentActivity>.activities.reversed().filter { seen.insert($0.attributes.lane).inserted }.sorted {
            if $0.attributes.lane == focusedLane { return true }
            if $1.attributes.lane == focusedLane { return false }
            return ($0.content.state.startedAt ?? .distantPast) > ($1.content.state.startedAt ?? .distantPast)
        }
    }

    /// The card's link, if the server gave it one the phone can open.
    func link(of activity: Activity<AgentActivity>) -> URL? {
        guard let s = activity.content.state.url, let u = URL(string: s),
              u.scheme == "https" || u.scheme == "claude" else { return nil }
        return u
    }

    /// Take the card off this phone. The server keeps its lane; the next content
    /// change from the Mac pushes to a dead activity and shows nothing, which is
    /// the point: this is for clearing a card you are done with.
    func dismiss(_ activity: Activity<AgentActivity>) {
        if focusedLane == activity.attributes.lane { focusedLane = nil }
        Task {
            await activity.end(nil, dismissalPolicy: .immediate)
            activitiesVersion += 1
        }
    }

    // MARK: - Actions

    /// `manual` is a tap on Pair; the automatic calls (launch, token rotation) stay
    /// silent unless something is wrong.
    func register(manual: Bool = false) async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            if manual { failed = true; status = "Live Activities are off for Ledge in iOS Settings" }
            return
        }
        guard let pushToStartToken, let deviceToken else {
            if manual { failed = true; status = "no push token from iOS yet; try again in a few seconds" }
            return
        }
        let wasPaired = paired
        if await post(
            "/register",
            ["pushToStartToken": pushToStartToken, "deviceToken": deviceToken],
            success: "paired"
        ) {
            paired = true
            if !wasPaired { await proveIt() }
        }
    }

    /// Put back every card that is no longer on this phone (swiped off the lock
    /// screen by accident, say). Starts them here rather than asking the Mac to
    /// push-to-start: a local start needs no APNs budget, which iOS throttles after
    /// a burst. Each new activity hands its token to the server through
    /// observeToken, so updates resume on their own.
    func restore() async {
        guard let lanes = await send("GET", "/lanes")?["lanes"] as? [String: Any] else { return }
        let showing = Set(Activity<AgentActivity>.activities.map(\.attributes.lane))
        var n = 0
        var errors: [String] = []
        for (lane, raw) in lanes where !showing.contains(lane) {
            guard let obj = raw as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: obj),
                  let state = try? JSONDecoder().decode(AgentActivity.ContentState.self, from: data)
            else { continue }
            do {
                let activity = try Activity<AgentActivity>.request(
                    attributes: AgentActivity(lane: lane),
                    content: .init(state: state, staleDate: nil),
                    pushType: .token
                )
                observeToken(of: activity)
                // Hand the token over before returning, so locking the phone right
                // after tapping Restore cannot leave the server holding the old one
                // (the end for that lane would then hit a dead activity and this card
                // would linger as a ghost). Bounded: iOS normally answers in well
                // under a second.
                let handover = Task { @MainActor in
                    for await data in activity.pushTokenUpdates {
                        await self.post("/token", ["lane": lane, "updateToken": data.hexString])
                        break
                    }
                }
                let deadline = Task { try? await Task.sleep(for: .seconds(5)); handover.cancel() }
                await handover.value
                deadline.cancel()
                n += 1
            } catch {
                errors.append(error.localizedDescription)
            }
        }
        failed = !errors.isEmpty
        status = errors.first ?? (n == 0 ? "nothing to restore, every card is already here" : "restored \(n) card\(n == 1 ? "" : "s")")
    }

    /// Tell the server about every card this phone shows, so it can end any it no
    /// longer holds (a ghost) and catch up on tokens it missed. Runs whenever the
    /// app comes to the foreground.
    func reconcile() async {
        // Two activities for one lane is a ghost pair (a restore raced a push).
        // Keep the newest, end the rest, so the server's token addresses the one left.
        var seen = Set<String>()
        for activity in Activity<AgentActivity>.activities.reversed() {
            if !seen.insert(activity.attributes.lane).inserted {
                await activity.end(nil, dismissalPolicy: .immediate)
                activitiesVersion += 1
            }
        }
        for activity in Activity<AgentActivity>.activities {
            guard let token = activity.pushToken else { continue }
            await post("/token", ["lane": activity.attributes.lane, "updateToken": token.hexString])
        }
    }

    /// The first successful pairing puts a card on the lock screen for 20 seconds,
    /// so "did it work" is answered by the lock screen, not by a status line.
    func proveIt() async {
        guard await post("/activity", [
            "lane": "paired", "template": "result", "tone": "ok",
            "title": "ledge", "line": "paired. this card leaves in 20 seconds",
        ], success: "paired. Lock the phone: a card is on the lock screen for 20 seconds.") else { return }
        Task {
            try? await Task.sleep(for: .seconds(20))
            await post("/activity/end", ["lane": "paired"])
        }
    }

    fileprivate func deviceTokenArrived(_ hex: String) {
        deviceToken = hex
        Task { await register() }
    }

    fileprivate func remoteRegistrationFailed(_ error: any Error) {
        status = error.localizedDescription
    }

    // MARK: - Transport

    @discardableResult
    private func post(_ path: String, _ body: [String: Any], success: String? = nil) async -> Bool {
        await send("POST", path, body, success: success) != nil
    }

    /// One request; the JSON object the server answered with, or nil on any
    /// failure with `status` already set to say why.
    private func send(_ method: String, _ path: String, _ body: [String: Any]? = nil, success: String? = nil) async -> [String: Any]? {
        failed = true
        guard let url = URL(string: serverURL.trimmingCharacters(in: .whitespaces) + path) else {
            status = "bad server URL"
            return nil
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        if let body { request.httpBody = try? JSONSerialization.data(withJSONObject: body) }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(code) else {
                let reason = String(data: data, encoding: .utf8) ?? ""
                status = code == 401
                    ? "The token does not match. Run `ledge pair` on your Mac and copy it again."
                    : "\(path) -> \(code) \(reason)".trimmingCharacters(in: .whitespaces)
                return nil
            }
            failed = false
            if let success { status = success }
            return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        } catch let error as URLError
            where [.cannotConnectToHost, .timedOut, .cannotFindHost, .notConnectedToInternet].contains(error.code) {
            status = "Cannot reach \(url.host() ?? "the server"). Is the server running, and is Tailscale on for both devices?"
            return nil
        } catch {
            status = error.localizedDescription
            return nil
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let hex = deviceToken.hexString
        Task { @MainActor in LedgeStore.shared.deviceTokenArrived(hex) }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: any Error
    ) {
        Task { @MainActor in LedgeStore.shared.remoteRegistrationFailed(error) }
    }
}

private extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
