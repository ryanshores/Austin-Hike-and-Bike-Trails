import SwiftUI

@main
struct AtlasMobileApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var rideRecordingCoordinator = RideRecordingCoordinator()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(rideRecordingCoordinator)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                rideRecordingCoordinator.applicationDidEnterBackground()
            case .active:
                rideRecordingCoordinator.applicationWillEnterForeground()
            case .inactive:
                break
            @unknown default:
                break
            }
        }
    }
}
