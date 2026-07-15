"use client";

import { useEffect, useRef, useState } from "react";
import type { Feature, FeatureCollection, LineString, MultiLineString } from "geojson";
import type { GeoJSON as LeafletGeoJSON, Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";

type Category = "offRoadBike" | "protectedBike" | "streetBike" | "roadHike" | "offRoadHike";
type TrailProperties = Record<string, string | number | null> & { category?: Category };
type TrailFeature = Feature<LineString | MultiLineString, TrailProperties>;

const categories: Record<Category, { label: string; note: string; color: string; dash?: string }> = {
  offRoadBike: { label: "Separated path, off road", note: "Lowest traffic exposure", color: "#1f6b4f" },
  protectedBike: { label: "On road, separated", note: "Protected lane or buffer", color: "#2f7ea1" },
  streetBike: { label: "On road, not separated", note: "Bike lane or shared street", color: "#c76535" },
  roadHike: { label: "Hiking on road", note: "Sidewalk or road connection", color: "#a85857", dash: "3 7" },
  offRoadHike: { label: "Hiking off road", note: "Park or urban trail", color: "#85944a", dash: "8 5" },
};

const bikeUrl = "https://maps.austintexas.gov/arcgis/rest/services/AmandaROW/Reference_1/MapServer/0/query?where=1%3D1&outFields=FULL_STREET_NAME%2CLINE_TYPE%2CBICYCLE_FACILITY%2CBIKE_LEVEL_OF_COMFORT&returnGeometry=true&outSR=4326&f=geojson&resultRecordCount=2000";
const hikeUrl = "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/TRANSPORTATION_urban_trails_network/FeatureServer/0/query?where=BUILD_STATUS%3D%27EXISTING%27&outFields=URBAN_TRAIL_SYSTEM_NAME%2CURBAN_TRAIL_NAME%2CTRAIL_SURFACE_TYPE%2CLOCATION%2CLENGTH_MILES&returnGeometry=true&outSR=4326&f=geojson&resultRecordCount=2000";

function classifyBike(properties: TrailProperties): Category {
  const facility = String(properties.BICYCLE_FACILITY ?? "").toLowerCase();
  const lineType = String(properties.LINE_TYPE ?? "").toLowerCase();
  if (lineType.includes("off-street") || facility.includes("trail") || facility.includes("shared use")) return "offRoadBike";
  if (facility.includes("protected") || facility.includes("buffer") || facility.includes("cycle track")) return "protectedBike";
  return "streetBike";
}

function escapeHtml(value: unknown) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character] ?? character));
}

export default function TrailMap() {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layersRef = useRef<Partial<Record<Category, LeafletGeoJSON>> >({});
  const [enabled, setEnabled] = useState<Record<Category, boolean>>({ offRoadBike: true, protectedBike: true, streetBike: true, roadHike: true, offRoadHike: true });
  const [status, setStatus] = useState("Loading City of Austin trail data…");

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;
    let cancelled = false;

    async function start() {
      const L = await import("leaflet");
      if (cancelled || !mapNode.current) return;
      const map = L.map(mapNode.current, { zoomControl: false, preferCanvas: true, minZoom: 9 }).setView([30.2672, -97.7431], 12);
      mapRef.current = map;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      L.control.zoom({ position: "topright" }).addTo(map);

      try {
        const [bikeResponse, hikeResponse] = await Promise.all([fetch(bikeUrl), fetch(hikeUrl)]);
        if (!bikeResponse.ok || !hikeResponse.ok) throw new Error("City trail service unavailable");
        const bike = (await bikeResponse.json()) as FeatureCollection<LineString | MultiLineString, TrailProperties>;
        const hike = (await hikeResponse.json()) as FeatureCollection<LineString | MultiLineString, TrailProperties>;
        const features: TrailFeature[] = [
          ...bike.features.map((f) => ({ ...f, properties: { ...f.properties, category: classifyBike(f.properties) } })),
          ...hike.features.map((f) => ({ ...f, properties: { ...f.properties, category: "offRoadHike" as Category } })),
        ];

        (Object.keys(categories) as Category[]).forEach((category) => {
          const collection: FeatureCollection<LineString | MultiLineString, TrailProperties> = {
            type: "FeatureCollection",
            features: features.filter((feature) => feature.properties.category === category),
          };
          const layer = L.geoJSON(collection, {
            style: { color: categories[category].color, weight: category.includes("Hike") ? 4 : 5, opacity: 0.92, dashArray: categories[category].dash },
            onEachFeature: (feature, featureLayer) => {
              const p = feature.properties as TrailProperties;
              const name = p.URBAN_TRAIL_NAME || p.URBAN_TRAIL_SYSTEM_NAME || p.FULL_STREET_NAME || "Austin trail segment";
              const detail = p.TRAIL_SURFACE_TYPE || p.BICYCLE_FACILITY || categories[category].note;
              featureLayer.bindPopup(`<strong>${escapeHtml(name)}</strong><br>${escapeHtml(categories[category].label)}<br><span>${escapeHtml(detail)}</span>`);
            },
          });
          layersRef.current[category] = layer;
          if (enabled[category]) layer.addTo(map);
        });
        setStatus(`${bike.features.length.toLocaleString()} bike segments · ${hike.features.length.toLocaleString()} existing trail segments`);
      } catch {
        setStatus("Live trail data could not load. Try refreshing when you have a connection.");
      }
    }

    start();
    return () => { cancelled = true; mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  function toggle(category: Category) {
    const next = !enabled[category];
    setEnabled((current) => ({ ...current, [category]: next }));
    const map = mapRef.current;
    const layer = layersRef.current[category];
    if (map && layer) next ? layer.addTo(map) : layer.removeFrom(map);
  }

  function locate() {
    mapRef.current?.locate({ setView: true, maxZoom: 15 });
  }

  return (
    <main className="atlas-shell">
      <header className="atlas-header">
        <div>
          <p className="eyebrow">Field guide · Austin, Texas</p>
          <h1>Hike & Bike Atlas</h1>
        </div>
        <button className="location-button" onClick={locate} aria-label="Center map on my location">◎ <span>My location</span></button>
      </header>

      <section className="map-frame" aria-label="Interactive map of Austin hike and bike paths">
        <div ref={mapNode} className="map" />
        <div className="map-stamp" aria-live="polite"><span className="stamp-dot" />{status}</div>
        <div className="north-mark" aria-hidden="true">N<span>↑</span></div>
      </section>

      <aside className="legend" aria-label="Trail type and safety legend">
        <div className="legend-heading">
          <div><p className="eyebrow">Route character</p><h2>Trail safety legend</h2></div>
          <p>Tap to show or hide</p>
        </div>
        <div className="legend-grid">
          {(Object.keys(categories) as Category[]).map((category) => (
            <button key={category} className={`legend-item ${enabled[category] ? "active" : ""}`} onClick={() => toggle(category)} aria-pressed={enabled[category]}>
              <span className="route-swatch" style={{ "--route-color": categories[category].color, "--route-dash": categories[category].dash ? "dashed" : "solid" } as React.CSSProperties} />
              <span><strong>{categories[category].label}</strong><small>{categories[category].note}</small></span>
            </button>
          ))}
        </div>
        <p className="legend-note">Use route markings as a planning aid, not a guarantee of current conditions. Check closures and use your judgment.</p>
      </aside>
    </main>
  );
}
