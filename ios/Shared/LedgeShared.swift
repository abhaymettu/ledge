import Foundation

/// What the app and the widget share: where the server is, and the last thing it said.
/// The App Group is group.<app bundle id>; the widget's bundle id is the app's + ".widget".
enum LedgeGroup {
    static var id: String {
        var app = Bundle.main.bundleIdentifier ?? "com.abhay.ledge"
        if app.hasSuffix(".widget") { app.removeLast(".widget".count) }
        return "group." + app
    }
    static var defaults: UserDefaults? { UserDefaults(suiteName: id) }

    static var server: (url: String, token: String)? {
        let d = defaults ?? .standard
        guard let url = d.string(forKey: "ledge.serverURL"), let token = d.string(forKey: "ledge.token"),
              !url.isEmpty, !token.isEmpty else { return nil }
        return (url.trimmingCharacters(in: .whitespaces), token)
    }

    /// Why the last tap on an approval did not land, by approval id. The widgets
    /// cannot ask the Mac anything themselves, so whichever process ran the tap
    /// leaves the reason here for them to draw.
    static var decideFailures: [String: String] {
        get { defaults?.dictionary(forKey: "ledge.decideFailures") as? [String: String] ?? [:] }
        set { defaults?.set(newValue, forKey: "ledge.decideFailures") }
    }
}

/// What a tap on Allow or Deny did. One case per thing that can go wrong on the
/// way to the Mac, because "nothing happened" is the one answer a button may
/// never give.
enum DecideOutcome: Equatable {
    case ok
    /// The server has no such approval: the hook stopped waiting and the question
    /// went back to the terminal. Ten minutes is the ceiling, the hook's own wait
    /// is usually the real one.
    case gone
    case unauthorized
    case unreachable
    /// No server address on this phone at all, which for the widgets also means
    /// the app group did not come through.
    case unpaired
    case refused(Int)

    /// The line the card shows. nil when there is nothing to say.
    var line: String? {
        switch self {
        case .ok: nil
        case .gone: "expired, answer it in the terminal"
        case .unauthorized: "token rejected, pair again in Ledge"
        case .unreachable: "cannot reach the Mac, is Tailscale on"
        case .unpaired: "not paired, open Ledge"
        case .refused(let code): "the Mac refused it (\(code))"
        }
    }
}

/// The one place a decision leaves the phone. The app, the Live Activity and the
/// home widget all come through here, so the same failure reads the same way
/// wherever it was tapped. Never swallows: every path returns a case with words.
func decideApproval(_ approvalId: String, _ decision: String) async -> DecideOutcome {
    guard let server = LedgeGroup.server,
          let url = URL(string: server.url + "/approvals/" + approvalId) else { return .unpaired }
    var request = URLRequest(url: url, timeoutInterval: 10)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue("Bearer \(server.token)", forHTTPHeaderField: "authorization")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["decision": decision])
    guard let (_, response) = try? await URLSession.shared.data(for: request) else { return .unreachable }
    let code = (response as? HTTPURLResponse)?.statusCode ?? 0
    switch code {
    case 200..<300: return .ok
    case 401: return .unauthorized
    case 404: return .gone
    default: return .refused(code)
    }
}

struct LedgeApproval: Identifiable, Codable, Hashable {
    let id: String
    let sessionId: String
    let tool: String
    let summary: String
    let at: Double
}

struct LedgeEnded: Identifiable, Codable, Hashable {
    let lane: String
    let card: AgentActivity.ContentState
    let endedAt: Double
    let outcome: String
    var id: String { lane + String(endedAt) }
}

/// One read of the server, as the widgets see it. Cached in the group so a widget
/// still has something to show when Tailscale is off.
struct LedgeSnapshot: Codable {
    var lanes: [String: AgentActivity.ContentState] = [:]
    var approvals: [LedgeApproval] = []
    var history: [LedgeEnded] = []
    var at: Date = .distantPast

    static let cacheKey = "ledge.snapshot"

    static var cached: LedgeSnapshot? {
        guard let data = LedgeGroup.defaults?.data(forKey: cacheKey) else { return nil }
        return try? JSONDecoder().decode(LedgeSnapshot.self, from: data)
    }

    func cache() {
        if let data = try? JSONEncoder().encode(self) { LedgeGroup.defaults?.set(data, forKey: Self.cacheKey) }
    }

    static func fetch() async -> LedgeSnapshot? {
        guard let server = LedgeGroup.server else { return nil }
        func get<T: Decodable>(_ path: String, _ key: String, as: T.Type) async -> T? {
            guard let url = URL(string: server.url + path) else { return nil }
            var request = URLRequest(url: url, timeoutInterval: 8)
            request.setValue("Bearer \(server.token)", forHTTPHeaderField: "authorization")
            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let inner = object[key], let innerData = try? JSONSerialization.data(withJSONObject: inner)
            else { return nil }
            return try? JSONDecoder().decode(T.self, from: innerData)
        }
        guard let lanes = await get("/lanes", "lanes", as: [String: AgentActivity.ContentState].self) else { return nil }
        var snapshot = LedgeSnapshot(lanes: lanes, at: .now)
        snapshot.approvals = await get("/approvals", "approvals", as: [LedgeApproval].self) ?? []
        snapshot.history = (await get("/history", "history", as: [LedgeEnded].self) ?? []).reversed()
        snapshot.cache()
        return snapshot
    }
}
