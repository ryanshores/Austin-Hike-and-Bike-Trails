import MapKit
import Foundation

struct BikeFacilityOverlay: Identifiable {
    enum Category: String { case offRoad, protectedLane, street }
    let id: String
    let category: Category
    let coordinates: [CLLocationCoordinate2D]
}

@MainActor
final class BikeFacilityOverlayStore: ObservableObject {
    @Published private(set) var facilities: [BikeFacilityOverlay] = []
    @Published private(set) var message = "Bike facilities load when Atlas is configured."
    private var requestGeneration = 0
    private var loadedBounds: MKCoordinateRegion?
    private var inFlightBounds: MKCoordinateRegion?

    func load(bounds: MKCoordinateRegion, baseURL: URL?) async {
        if let loadedBounds, Self.contains(loadedBounds, bounds) {
            requestGeneration += 1
            return
        }
        if let inFlightBounds, Self.contains(inFlightBounds, bounds) { return }
        requestGeneration += 1
        let generation = requestGeneration
        guard let baseURL else { return }
        let requested = MKCoordinateRegion(
            center: bounds.center,
            span: MKCoordinateSpan(latitudeDelta: bounds.span.latitudeDelta * 1.5, longitudeDelta: bounds.span.longitudeDelta * 1.5)
        )
        let west = requested.center.longitude - requested.span.longitudeDelta / 2
        let east = requested.center.longitude + requested.span.longitudeDelta / 2
        let south = requested.center.latitude - requested.span.latitudeDelta / 2
        let north = requested.center.latitude + requested.span.latitudeDelta / 2
        guard east - west <= 5, north - south <= 5 else { return }
        inFlightBounds = requested
        defer { inFlightBounds = nil }
        var components = URLComponents(url: baseURL.appendingPathComponent("api/bike-facilities"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "bounds", value: "\(west),\(south),\(east),\(north)")]
        do {
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let collection = try JSONDecoder().decode(FeatureCollection.self, from: data)
            guard generation == requestGeneration else { return }
            facilities = collection.features.flatMap(BikeFacilityOverlay.overlays)
            loadedBounds = MKCoordinateRegion(
                center: requested.center,
                span: requested.span
            )
            message = "\(facilities.count) bike facilities in view"
        } catch { message = "Bike facilities could not update." }
    }

    private static func contains(_ outer: MKCoordinateRegion, _ inner: MKCoordinateRegion) -> Bool {
        let outerLat = outer.span.latitudeDelta / 2
        let outerLon = outer.span.longitudeDelta / 2
        let innerLat = inner.span.latitudeDelta / 2
        let innerLon = inner.span.longitudeDelta / 2
        return abs(inner.center.latitude - outer.center.latitude) + innerLat <= outerLat
            && abs(inner.center.longitude - outer.center.longitude) + innerLon <= outerLon
    }

    struct FeatureCollection: Decodable { let features: [Feature] }
    struct Feature: Decodable { let properties: Properties; let geometry: Geometry }
    struct Properties: Decodable {
        let objectId: Int?
        let bicycleFacility: String?
        let lineType: String?
        enum CodingKeys: String, CodingKey { case objectId = "OBJECTID", bicycleFacility = "BICYCLE_FACILITY", lineType = "LINE_TYPE" }
    }
    struct Geometry: Decodable {
        let type: String
        let coordinates: [[[Double]]]
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            type = try c.decode(String.self, forKey: .type)
            if let line = try? c.decode([[Double]].self, forKey: .coordinates) { coordinates = [line] }
            else { coordinates = try c.decode([[[Double]]].self, forKey: .coordinates) }
        }
        enum CodingKeys: String, CodingKey { case type, coordinates }
    }
}

private extension BikeFacilityOverlay {
    static func overlays(feature: BikeFacilityOverlayStore.Feature) -> [BikeFacilityOverlay] {
        guard feature.geometry.type == "LineString" || feature.geometry.type == "MultiLineString" else { return [] }
        let lines = feature.geometry.coordinates.map { $0.compactMap { $0.count >= 2 ? CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) : nil } }.filter { $0.count > 1 }
        guard !lines.isEmpty else { return [] }
        let facility = feature.properties.bicycleFacility?.lowercased() ?? ""
        let line = feature.properties.lineType?.lowercased() ?? ""
        let category: Category = line.contains("off-street") || facility.contains("trail") || facility.contains("shared use") ? .offRoad : (facility.contains("protected") || facility.contains("buffer") || facility.contains("cycle track") || facility.contains("wparking") ? .protectedLane : .street)
        return lines.enumerated().map { index, coordinates in BikeFacilityOverlay(id: "\(feature.properties.objectId.map(String.init) ?? UUID().uuidString)-\(index)", category: category, coordinates: coordinates) }
    }
}
