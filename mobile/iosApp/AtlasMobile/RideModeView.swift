import CoreLocation
import MapKit
import SwiftUI

/// The iOS Ride Mode surface deliberately renders only shared-policy accepted positions.
struct RideModeView: View {
    @ObservedObject private var coordinator: RideRecordingCoordinator
    @ObservedObject private var locationAdapter: RideLocationAdapter
    @State private var mapPosition = MapCameraPosition.region(Self.austinRegion)
    @State private var showingSessionRequirement = false

    init(coordinator: RideRecordingCoordinator) {
        _coordinator = ObservedObject(wrappedValue: coordinator)
        _locationAdapter = ObservedObject(wrappedValue: coordinator.locationAdapter)
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            Map(position: $mapPosition) {
                if let coordinate = trustedCoordinate {
                    MapCircle(center: coordinate, radius: max(trustedAccuracyMeters, 5))
                        .foregroundStyle(statusColor.opacity(0.16))
                        .stroke(statusColor.opacity(0.8), lineWidth: 1)
                    Annotation("Accepted position", coordinate: coordinate) {
                        Image(systemName: "figure.outdoor.cycle.circle.fill")
                            .font(.title)
                            .foregroundStyle(statusColor, .white)
                            .accessibilityLabel("Last trustworthy position")
                    }
                }
            }
            .mapStyle(.standard(elevation: .flat, emphasis: .muted))
            .ignoresSafeArea(edges: .top)

            VStack(spacing: 12) {
                statusCard
                controls
            }
            .padding()
        }
        .alert("Native session required", isPresented: $showingSessionRequirement) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Ride recording will be available after the native session host supplies a verified owner. The app will not create an unowned ride.")
        }
        .onChange(of: trustedTimestamp) { _, _ in
            guard let coordinate = trustedCoordinate else { return }
            mapPosition = .region(MKCoordinateRegion(
                center: coordinate,
                span: MKCoordinateSpan(latitudeDelta: 0.008, longitudeDelta: 0.008)
            ))
        }
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Ride Mode", systemImage: "figure.outdoor.cycle")
                    .font(.headline)
                Spacer()
                Text(recordingLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(statusColor)
            }
            Text(gpsStatus)
                .font(.subheadline.weight(.medium))
            Text(queueStatus)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var controls: some View {
        HStack(spacing: 12) {
            if coordinator.activeRide == nil {
                Button {
                    showingSessionRequirement = true
                } label: {
                    Label("Start ride", systemImage: "record.circle")
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
            } else {
                Button {
                    coordinator.stopRide()
                } label: {
                    Label("Stop ride", systemImage: "stop.circle")
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
            }
        }
        .frame(maxWidth: .infinity)
        .controlSize(.large)
    }

    private var trustedCoordinate: CLLocationCoordinate2D? {
        guard let fix = locationAdapter.latestTrustedFix else { return nil }
        return CLLocationCoordinate2D(latitude: fix.latitude, longitude: fix.longitude)
    }

    private var trustedAccuracyMeters: CLLocationDistance {
        locationAdapter.latestTrustedFix?.accuracyMeters ?? 0
    }

    private var trustedTimestamp: Int64? {
        locationAdapter.latestTrustedFix?.timestampMilliseconds
    }

    private var recordingLabel: String {
        switch locationAdapter.trackingState {
        case .recording: "Recording"
        case .awaitingAuthorization: "Permission needed"
        case .unavailable: "GPS unavailable"
        case .stopped: "Stopped"
        case .idle: "Ready"
        }
    }

    private var gpsStatus: String {
        guard let decision = locationAdapter.latestDecision else {
            return locationAdapter.latestTrustedFix == nil ? "Acquiring a trustworthy GPS fix" : "Holding the last trustworthy GPS fix"
        }
        switch decision.action.wireValue {
        case "use-fix": return "GPS \(decision.quality.wireValue) — position accepted"
        case "keep-last-fix": return "GPS unusable — holding the last trustworthy position"
        case "reject-jump": return "GPS jump rejected — holding the last trustworthy position"
        default: return "Waiting for a trustworthy GPS fix"
        }
    }

    private var queueStatus: String {
        let count = coordinator.queuedPointCount
        return count == 0 ? "No accepted points queued" : "\(count) accepted \(count == 1 ? "point" : "points") queued for upload"
    }

    private var statusColor: Color {
        guard let decision = locationAdapter.latestDecision else { return .orange }
        return switch decision.quality.wireValue {
        case "good": Color.green
        case "fair": Color.orange
        case "poor": Color.yellow
        default: Color.red
        }
    }

    private static let austinRegion = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 30.2672, longitude: -97.7431),
        span: MKCoordinateSpan(latitudeDelta: 0.08, longitudeDelta: 0.08)
    )
}
