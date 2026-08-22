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

    func load(bounds: MKCoordinateRegion, baseURL: URL?) async {
        guard let baseURL else { return }
        let west = bounds.center.longitude - bounds.span.longitudeDelta / 2
        let east = bounds.center.longitude + bounds.span.longitudeDelta / 2
        let south = bounds.center.latitude - bounds.span.latitudeDelta / 2
        let north = bounds.center.latitude + bounds.span.latitudeDelta / 2
        guard east - west <= 5, north - south <= 5 else { return }
        var components = URLComponents(url: baseURL.appendingPathComponent("api/bike-facilities"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "bounds", value: "\(west),\(south),\(east),\(north)")]
        do {
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let collection = try JSONDecoder().decode(FeatureCollection.self, from: data)
            facilities = collection.features.compactMap(BikeFacilityOverlay.init)
            message = "\(facilities.count) bike facilities in view"
        } catch { message = "Bike facilities could not update." }
    }

    struct FeatureCollection: Decodable { let features: [Feature] }
    struct Feature: Decodable { let properties: [String: String]?; let geometry: Geometry }
    struct Geometry: Decodable { let type: String; let coordinates: [[Double]] }
}

private extension BikeFacilityOverlay {
    init?(feature: BikeFacilityOverlayStore.Feature) {
        guard feature.geometry.type == "LineString" else { return nil }
        let coordinates = feature.geometry.coordinates.compactMap { $0.count >= 2 ? CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) : nil }
        guard coordinates.count > 1 else { return nil }
        let facility = feature.properties?["BICYCLE_FACILITY"]?.lowercased() ?? ""
        let line = feature.properties?["LINE_TYPE"]?.lowercased() ?? ""
        let category: Category = line.contains("off-street") || facility.contains("trail") || facility.contains("shared use") ? .offRoad : (facility.contains("protected") || facility.contains("buffer") || facility.contains("cycle track") ? .protectedLane : .street)
        self.init(id: feature.properties?["OBJECTID"] ?? UUID().uuidString, category: category, coordinates: coordinates)
    }
}
