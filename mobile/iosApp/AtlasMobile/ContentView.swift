import AtlasShared
import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var rideRecordingCoordinator: RideRecordingCoordinator

    var body: some View {
        RideModeView(coordinator: rideRecordingCoordinator)
    }
}

//#Preview("Ride Mode") {
//    ContentView()
//        .environmentObject(RideRecordingCoordinator())
//}
