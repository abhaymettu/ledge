import SwiftUI
import UIKit

@main
struct LedgeApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                // Tapping a Live Activity opens THIS app (the one that owns the
                // activity), not the activity's widgetURL target. So the card's
                // claude://code/<id> link arrives here; bounce it on to the Claude
                // app. Without this the tap dead-ends on Ledge.
                // A card with no Claude link opens ledge://lane/<lane> instead, so
                // the app can show that session rather than a blank screen.
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        LedgeStore.shared.activated()
                        Task { await LedgeStore.shared.reconcile() }
                    }
                    // Claude is up; next time this app is seen, show the real screens.
                    if phase == .background { LedgeStore.shared.handingOff = false }
                }
                .onOpenURL { url in
                    switch url.scheme {
                    case "claude":
                        LedgeStore.shared.handingOff = true
                        UIApplication.shared.open(url)
                    case "ledge": LedgeStore.shared.focusedLane = url.host() ?? url.pathComponents.last
                    default: break
                    }
                }
        }
    }
}
