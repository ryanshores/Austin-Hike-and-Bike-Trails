import CoreLocation
import AtlasShared
import MapKit
import SwiftUI

/// The iOS Ride Mode surface deliberately renders only shared-policy accepted positions.
struct RideModeView: View {
    private enum OrientationMode: Equatable {
        case northUp
        case forwardUp

        var label: String { self == .northUp ? "North up" : "Forward up" }
        var icon: String { self == .northUp ? "location.north.fill" : "location.fill" }
    }

    @ObservedObject private var coordinator: RideRecordingCoordinator
    @ObservedObject private var locationAdapter: RideLocationAdapter
    @EnvironmentObject private var nativeSessionHost: NativeSessionHost
    @State private var mapPosition = MapCameraPosition.region(Self.austinRegion)
    @State private var orientationMode = OrientationMode.northUp
    @StateObject private var bikeFacilities = BikeFacilityOverlayStore()
    @State private var pendingDiagnosticExport: DiagnosticExportPayload?

    init(coordinator: RideRecordingCoordinator) {
        _coordinator = ObservedObject(wrappedValue: coordinator)
        _locationAdapter = ObservedObject(wrappedValue: coordinator.locationAdapter)
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            Map(position: $mapPosition) {
                ForEach(bikeFacilities.facilities) { facility in
                    MapPolyline(coordinates: facility.coordinates)
                        .stroke(facilityColor(facility.category), lineWidth: 2)
                }
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
            .onMapCameraChange(frequency: .onEnd) { context in
                Task { await bikeFacilities.load(bounds: context.region, baseURL: atlasBaseURL) }
            }
            .ignoresSafeArea(edges: .top)

            VStack(spacing: 12) {
                statusCard
                controls
                diagnosticExport
            }
            .padding()
        }
        .task {
            await nativeSessionHost.prepare()
            if let session = nativeSessionHost.session {
                coordinator.resumeActiveRide(sessionOwnerId: session.ownerId)
            }
        }
        .alert("Discard interrupted ride?", isPresented: Binding(
            get: { coordinator.identityChangeRide != nil },
            set: { if !$0 { coordinator.dismissIdentityChangeNotice() } }
        )) {
            Button("Discard ride", role: .destructive) {
                if let owner = nativeSessionHost.session?.ownerId {
                    coordinator.discardIdentityMismatchedRide(currentOwnerId: owner)
                }
            }
            Button("Keep ride", role: .cancel) {}
        } message: {
            Text("This interrupted ride belongs to a different account. Keeping it preserves its local points until that account is restored.")
        }
        .onChange(of: trustedTimestamp) { _, _ in
            recenterOnTrustedPosition()
        }
        .onChange(of: orientationMode) { _, _ in
            recenterOnTrustedPosition()
        }
        .sheet(item: $pendingDiagnosticExport) { export in
            VStack(spacing: 20) {
                Text("Share field diagnostic")
                    .font(.headline)
                Text("This export contains Ride Mode status only. It excludes location history and credentials.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                ShareLink(item: export.data, preview: SharePreview("Atlas Ride Mode diagnostic")) {
                    Label("Share diagnostic", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.borderedProminent)
            }
            .padding()
            .presentationDetents([.height(210)])
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
            Button {
                orientationMode = orientationMode == .northUp ? .forwardUp : .northUp
            } label: {
                Label(orientationMode.label, systemImage: orientationMode.icon)
            }
            .buttonStyle(.bordered)
            .accessibilityHint("Changes the map orientation using only the last accepted location heading")

            if coordinator.identityBlockedRide != nil {
                Label("Restore the previous account to continue this ride", systemImage: "lock.fill")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            } else if coordinator.activeRide == nil {
                if nativeSessionHost.state == .unavailable {
                    Button { Task { await nativeSessionHost.prepare() } } label: {
                        Label("Reconnect", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                } else {
                    Button {
                        guard let session = nativeSessionHost.session else { return }
                        let now = Int64(Date().timeIntervalSince1970 * 1_000)
                        _ = coordinator.startRide(rideId: UUID().uuidString, ownerId: session.ownerId, startedAtMilliseconds: now, nowMilliseconds: now)
                    } label: {
                        Label("Start ride", systemImage: "record.circle")
                    }
                    .disabled(nativeSessionHost.state != .ready)
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                }
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

    private var diagnosticExport: some View {
        Button {
            pendingDiagnosticExport = DiagnosticExportPayload(data: makeDiagnosticExportData())
        } label: {
            Label("Export field diagnostic", systemImage: "square.and.arrow.up")
        }
        .font(.footnote.weight(.medium))
        .accessibilityHint("Exports recording and GPS state without location history or credentials")
    }

    private func makeDiagnosticExportData() -> Data {
        let snapshot = RideDiagnosticExport(
            exportedAt: .now,
            appVersion: appVersion,
            recordingState: recordingLabel,
            locationAuthorization: locationAdapter.authorizationDiagnosticValue,
            locationPrecision: locationAdapter.precisionDiagnosticValue,
            gpsDecision: locationAdapter.latestDecision?.action.wireValue,
            gpsQuality: locationAdapter.latestDecision?.quality.wireValue,
            hasTrustworthyPosition: locationAdapter.latestTrustedFix != nil,
            trustworthyAccuracyMeters: locationAdapter.latestTrustedFix?.accuracyMeters,
            queuedPointCount: coordinator.queuedPointCount,
            activeRideState: coordinator.activeRide?.status.wireValue,
            identityChangeBlocked: coordinator.identityBlockedRide != nil
        )
        return (try? snapshot.jsonData()) ?? Data("{}".utf8)
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

    private func recenterOnTrustedPosition() {
        guard let coordinate = trustedCoordinate else { return }
        let heading = orientationMode == .forwardUp
            ? locationAdapter.latestTrustedHeadingDegrees ?? 0
            : 0
        mapPosition = .camera(MapCamera(
            centerCoordinate: coordinate,
            distance: 1_000,
            heading: heading,
            pitch: 0
        ))
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

    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
        return "\(version) (\(build))"
    }

    private var atlasBaseURL: URL? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "AtlasApiBaseURL") as? String else { return nil }
        return URL(string: value)
    }

    private func facilityColor(_ category: BikeFacilityOverlay.Category) -> Color {
        switch category { case .offRoad: .green; case .protectedLane: .blue; case .street: .orange }
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

private struct DiagnosticExportPayload: Identifiable {
    let id = UUID()
    let data: Data
}
