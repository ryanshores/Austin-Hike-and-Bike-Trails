"use client";

import { useEffect, useRef, useState } from "react";
import type { Feature, FeatureCollection, LineString, MultiLineString } from "geojson";
import type { GeoJSON as LeafletGeoJSON, Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";

type Category = "offRoadBike" | "protectedBike" | "streetBike" | "offRoadHike";
type TrailProperties = Record<string, string | number | null> & { category?: Category };
type TrailFeature = Feature<LineString | MultiLineString, TrailProperties>;
type ArcGISFeatureCollection = FeatureCollection<LineString | MultiLineString, TrailProperties> & {
  properties?: { exceededTransferLimit?: boolean };
};

const categories: Record<Category, { label: string; note: string; color: string; dash?: string }> = {
  offRoadBike: { label: "Separated path, off road", note: "Lowest traffic exposure", color: "#1f6b4f" },
  protectedBike: { label: "On road, separated", note: "Protected lane or buffer", color: "#2f7ea1" },
  streetBike: { label: "On road, not separated", note: "Bike lane or shared street", color: "#c76535" },
  offRoadHike: { label: "Hiking off road", note: "Park or urban trail", color: "#85944a", dash: "8 5" },
};

const bikeEndpoint = "https://maps.austintexas.gov/arcgis/rest/services/AmandaROW/Reference_1/MapServer/0/query";
const hikeUrl = "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/TRANSPORTATION_urban_trails_network/FeatureServer/0/query?where=BUILD_STATUS%3D%27EXISTING%27&outFields=URBAN_TRAIL_SYSTEM_NAME%2CURBAN_TRAIL_NAME%2CTRAIL_SURFACE_TYPE%2CLOCATION%2CLENGTH_MILES&returnGeometry=true&outSR=4326&f=geojson&resultRecordCount=2000";

function classifyBike(properties: TrailProperties): Category {
  const facility = String(properties.BICYCLE_FACILITY ?? "").toLowerCase();
  const lineType = String(properties.LINE_TYPE ?? "").toLowerCase();
  if (lineType.includes("off-street") || facility.includes("trail") || facility.includes("shared use")) return "offRoadBike";
  if (facility.includes("protected") || facility.includes("buffer") || facility.includes("cycle track") || facility.includes("wparking")) return "protectedBike";
  return "streetBike";
}

function escapeHtml(value: unknown) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character] ?? character));
}

function routeWeight(category: Category, zoom: number) {
  const base = zoom <= 10 ? 1.15
    : zoom <= 12 ? 1.5
      : zoom <= 14 ? 1.9
        : zoom <= 16 ? 2.5
          : zoom === 17 ? 3.1
            : zoom === 18 ? 3.7
              : 4.2;
  return category === "offRoadHike" ? Math.max(1, base - 0.2) : base;
}

export default function TrailMap() {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layersRef = useRef<Partial<Record<Category, LeafletGeoJSON>> >({});
  const [enabled, setEnabled] = useState<Record<Category, boolean>>({ offRoadBike: true, protectedBike: true, streetBike: true, offRoadHike: true });
  const [status, setStatus] = useState("Loading City of Austin trail data…");

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;
    let cancelled = false;
    let bikeRequest: AbortController | null = null;

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

      (Object.keys(categories) as Category[]).forEach((category) => {
        const layer = L.geoJSON(undefined, {
          style: { color: categories[category].color, weight: routeWeight(category, map.getZoom()), opacity: 0.92, dashArray: categories[category].dash },
          onEachFeature: (feature, featureLayer) => {
            const p = feature.properties as TrailProperties;
            const name = p.URBAN_TRAIL_NAME || p.URBAN_TRAIL_SYSTEM_NAME || p.FULL_STREET_NAME || "Austin trail segment";
            const detail = p.TRAIL_SURFACE_TYPE || p.BICYCLE_FACILITY || categories[category].note;
            featureLayer.bindPopup(`<strong>${escapeHtml(name)}</strong><br>${escapeHtml(categories[category].label)}<br><span>${escapeHtml(detail)}</span>`);
          },
        });
        layersRef.current[category] = layer;
        layer.addTo(map);
      });

      const updateRouteWeights = () => {
        const zoom = map.getZoom();
        (Object.keys(categories) as Category[]).forEach((category) => {
          layersRef.current[category]?.setStyle({ weight: routeWeight(category, zoom) });
        });
      };
      map.on("zoomend", updateRouteWeights);

      let hikeCount = 0;
      let bikeCount = 0;
      const updateStatus = () => setStatus(`${bikeCount.toLocaleString()} bike facilities in view · ${hikeCount.toLocaleString()} existing trail segments`);

      async function loadHikes() {
        const response = await fetch(hikeUrl);
        if (!response.ok) throw new Error("Urban trail service unavailable");
        const data = (await response.json()) as ArcGISFeatureCollection;
        const features = data.features.map((feature) => ({ ...feature, properties: { ...feature.properties, category: "offRoadHike" as Category } }));
        layersRef.current.offRoadHike?.addData({ type: "FeatureCollection", features });
        hikeCount = features.length;
        updateStatus();
      }

      async function loadBikeFacilities() {
        bikeRequest?.abort();
        bikeRequest = new AbortController();
        const signal = bikeRequest.signal;
        setStatus("Updating bike routes for this area…");
        const bounds = map.getBounds();
        const geometry = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(",");
        const pageSize = 2000;
        const features: TrailFeature[] = [];

        for (let offset = 0; offset < 20000; offset += pageSize) {
          const parameters = new URLSearchParams({
            where: "BICYCLE_FACILITY IS NOT NULL",
            outFields: "OBJECTID,FULL_STREET_NAME,LINE_TYPE,BICYCLE_FACILITY,BIKE_LEVEL_OF_COMFORT",
            returnGeometry: "true",
            outSR: "4326",
            geometry,
            geometryType: "esriGeometryEnvelope",
            inSR: "4326",
            spatialRel: "esriSpatialRelIntersects",
            orderByFields: "OBJECTID",
            resultOffset: String(offset),
            resultRecordCount: String(pageSize),
            f: "geojson",
          });
          const response = await fetch(`${bikeEndpoint}?${parameters}`, { signal });
          if (!response.ok) throw new Error("Bicycle facility service unavailable");
          const page = (await response.json()) as ArcGISFeatureCollection;
          features.push(...page.features.map((feature) => ({ ...feature, properties: { ...feature.properties, category: classifyBike(feature.properties) } })));
          if (!page.properties?.exceededTransferLimit || page.features.length < pageSize) break;
        }

        if (signal.aborted || cancelled) return;
        (["offRoadBike", "protectedBike", "streetBike"] as Category[]).forEach((category) => {
          const layer = layersRef.current[category];
          layer?.clearLayers();
          layer?.addData({ type: "FeatureCollection", features: features.filter((feature) => feature.properties.category === category) });
        });
        bikeCount = features.length;
        updateStatus();
      }

      const refreshBikes = () => { loadBikeFacilities().catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("Bike routes could not update. Try refreshing when you have a connection.");
      }); };
      map.on("moveend", refreshBikes);
      loadHikes().catch(() => setStatus("Urban trails could not load. Try refreshing when you have a connection."));
      refreshBikes();
    }

    start();
    return () => { cancelled = true; bikeRequest?.abort(); mapRef.current?.remove(); mapRef.current = null; };
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
