import SwiftUI

@main
struct AtlasMobileApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var rideRecordingCoordinator = RideRecordingCoordinator()
    @StateObject private var nativeSessionHost = NativeSessionHost()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(rideRecordingCoordinator)
                .environmentObject(nativeSessionHost)
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
