import SwiftUI
import WidgetKit

@main
struct LedgeWidgetBundle: WidgetBundle {
    var body: some Widget {
        LedgeLiveActivity()
        NeedsYouWidget()
        FleetWidget()
    }
}
