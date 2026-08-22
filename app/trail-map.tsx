"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Feature, FeatureCollection, LineString, MultiLineString } from "geojson";
import type { Circle, CircleMarker, GeoJSON as LeafletGeoJSON, LatLng, Map as LeafletMap, Marker } from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  isPlausibleLocationChange,
  locationFixAction,
  locationQuality,
  MAX_FIX_AGE_MS,
  smoothingWeight,
} from "./location-accuracy";
import { forwardMapBearing, installMapSizeSync, mapOptionsForMode, nextForwardMapBearing } from "./map-runtime";
import { clearRouteGuidance, loadRouteGuidance, saveRouteGuidance } from "./route-guidance.js";
import { RouteGuidanceCard } from "./route-guidance-card.js";
import { guidanceQualityCanAdvance, initialGuidanceProgress, updateGuidanceProgress } from "./route-guidance-progress.js";
import { RouteOffRouteAlert } from "./route-off-route-alert.js";
import {
  guidanceProgressAfterOffRouteCheck,
  initialOffRouteState,
  rerouteFixIsFresh,
  rerouteRequest,
  updateOffRouteState,
} from "./route-off-route.js";
import { formatMiles, normalizePlannedRoute, routeErrorMessage } from "./route-planner-utils.js";
import { RideRecorder } from "./ride-recorder";
import { ensureUser } from "./account-history-api";
import RoutePlanner, {
  type PlannedRoute,
  type PlanningEndpointKey,
  type PlanningEndpoints,
  type PlanningPoint,
} from "./route-planner";

type Category = "offRoadBike" | "protectedBike" | "streetBike" | "offRoadHike";
type Orientation = "north" | "forward";
type TrailProperties = Record<string, string | number | null> & { category?: Category };
type TrailFeature = Feature<LineString | MultiLineString, TrailProperties>;
type MapMode = "trails" | "ride";
type SearchRecord = { category: Category; detail: string; label: string; latitude: number; longitude: number };
type DiagnosticSample = {
  accepted: boolean;
  accuracy: number;
  action: string;
  heading: number | null;
  latitude: number;
  longitude: number;
  quality: string;
  speed: number | null;
  timestamp: number;
  visibility: DocumentVisibilityState;
};
type WakeLockSentinelLike = EventTarget & { release: () => Promise<void>; released: boolean };
type ArcGISFeatureCollection = FeatureCollection<LineString | MultiLineString, TrailProperties> & {
  properties?: { exceededTransferLimit?: boolean };
};
type RouteGuidance = {
  version: number;
  createdAt: number;
  safetyPreference: string;
  endpoints: { start: PlanningPoint; destination: PlanningPoint };
  route: PlannedRoute;
};
type GuidanceProgress = ReturnType<typeof initialGuidanceProgress>;
type OffRouteState = ReturnType<typeof initialOffRouteState>;
type GuidancePoint = { accuracyMeters: number; latitude: number; longitude: number; timestamp: number };

const categories: Record<Category, { label: string; note: string; color: string; dash?: string }> = {
  offRoadBike: { label: "Separated path, off road", note: "Lowest traffic exposure", color: "#1f6b4f" },
  protectedBike: { label: "On road, separated", note: "Protected lane or buffer", color: "#2f7ea1" },
  streetBike: { label: "On road, not separated", note: "Bike lane or shared street", color: "#c76535" },
  offRoadHike: { label: "Hiking off road", note: "Park or urban trail", color: "#85944a", dash: "8 5" },
};

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

function bearingBetween(start: LatLng, end: LatLng) {
  const startLat = start.lat * Math.PI / 180;
  const endLat = end.lat * Math.PI / 180;
  const longitudeDelta = (end.lng - start.lng) * Math.PI / 180;
  const y = Math.sin(longitudeDelta) * Math.cos(endLat);
  const x = Math.cos(startLat) * Math.sin(endLat) - Math.sin(startLat) * Math.cos(endLat) * Math.cos(longitudeDelta);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function featureCenter(feature: TrailFeature) {
  const lines = feature.geometry.type === "LineString" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const points = lines.flat();
  if (points.length === 0) return null;
  const totals = points.reduce((sum, point) => ({ longitude: sum.longitude + point[0], latitude: sum.latitude + point[1] }), { longitude: 0, latitude: 0 });
  return { latitude: totals.latitude / points.length, longitude: totals.longitude / points.length };
}

function searchRecordsForFeatures(features: TrailFeature[]) {
  return features.flatMap((feature) => {
    const center = featureCenter(feature);
    if (!center) return [];
    const properties = feature.properties;
    const category = properties.category ?? classifyBike(properties);
    const label = String(properties.URBAN_TRAIL_NAME || properties.URBAN_TRAIL_SYSTEM_NAME || properties.FULL_STREET_NAME || "Austin trail segment");
    const detail = String(properties.TRAIL_SURFACE_TYPE || properties.BICYCLE_FACILITY || categories[category].note);
    return [{ category, detail, label, ...center }];
  });
}

export default function TrailMap({ mode = "trails" }: { mode?: MapMode }) {
  const isRide = mode === "ride";
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const layersRef = useRef<Partial<Record<Category, LeafletGeoJSON>> >({});
  const watchIdRef = useRef<number | null>(null);
  const locationMarkerRef = useRef<CircleMarker | null>(null);
  const accuracyCircleRef = useRef<Circle | null>(null);
  const lastLocationRef = useRef<LatLng | null>(null);
  const lastAccuracyRef = useRef<number | null>(null);
  const lastTimestampRef = useRef<number | null>(null);
  const lastHeadingRef = useRef<number | null>(null);
  const orientationRef = useRef<Orientation>("north");
  const diagnosticsRef = useRef<DiagnosticSample[]>([]);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const rideRecorderRef = useRef<RideRecorder | null>(null);
  const searchRecordsRef = useRef<Partial<Record<Category, SearchRecord[]>>>({});
  const planningEndpointMarkersRef = useRef<Partial<Record<PlanningEndpointKey, Marker>>>({});
  const guidanceDestinationMarkerRef = useRef<Marker | null>(null);
  const activeGuidanceRef = useRef<RouteGuidance | null>(null);
  const guidanceProgressRef = useRef<GuidanceProgress | null>(null);
  const offRouteStateRef = useRef<OffRouteState>(initialOffRouteState());
  const lastGuidancePointRef = useRef<GuidancePoint | null>(null);
  const rerouteFreshnessTimerRef = useRef<number | null>(null);
  const rerouteControllerRef = useRef<AbortController | null>(null);
  const plannedRouteLayerRef = useRef<LeafletGeoJSON | null>(null);
  const divergenceLayerRef = useRef<LeafletGeoJSON | null>(null);
  const activeMapTargetRef = useRef<PlanningEndpointKey | null>(null);
  const planningEndpointsRef = useRef<PlanningEndpoints>({ start: null, destination: null });
  const [enabled, setEnabled] = useState<Record<Category, boolean>>({ offRoadBike: true, protectedBike: true, streetBike: true, offRoadHike: true });
  const [status, setStatus] = useState("Loading City of Austin trail data…");
  const [tracking, setTracking] = useState(false);
  const [orientation, setOrientationState] = useState<Orientation>("north");
  const [bearing, setBearing] = useState(0);
  const [gpsQuality, setGpsQuality] = useState("acquiring");
  const [diagnosticCount, setDiagnosticCount] = useState(0);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [hasInterruptedRide, setHasInterruptedRide] = useState(false);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [, setSearchVersion] = useState(0);
  const [mapVersion, setMapVersion] = useState(0);
  const [activeMapTarget, setActiveMapTarget] = useState<PlanningEndpointKey | null>(null);
  const [planningEndpoints, setPlanningEndpoints] = useState<PlanningEndpoints>({ start: null, destination: null });
  const [plannedRoute, setPlannedRoute] = useState<PlannedRoute | null>(null);
  const [activeGuidance, setActiveGuidance] = useState<RouteGuidance | null>(null);
  const [guidanceProgress, setGuidanceProgress] = useState<GuidanceProgress | null>(null);
  const [offRouteState, setOffRouteState] = useState<OffRouteState>(initialOffRouteState);
  const [rerouteFixFresh, setRerouteFixFresh] = useState(false);
  const [rerouting, setRerouting] = useState(false);
  const [rerouteMessage, setRerouteMessage] = useState("");
  const [showLoginReminder, setShowLoginReminder] = useState(false);
  const [checkingIdentity, setCheckingIdentity] = useState(false);

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;
    let cancelled = false;
    let bikeRequest: AbortController | null = null;
    let loadedBikeBounds: import("leaflet").LatLngBounds | null = null;

    async function start() {
      const L = await import("leaflet");
      (window as typeof window & { L: typeof L }).L = L;
      await import("leaflet-rotate");
      if (cancelled || !mapNode.current) return;
      leafletRef.current = L;
      const map = L.map(mapNode.current, mapOptionsForMode(isRide)).setView([30.2672, -97.7431], 12);
      mapRef.current = map;
      const routePane = map.createPane("planned-route");
      routePane.style.zIndex = "460";
      routePane.style.pointerEvents = "none";
      const markerPane = map.createPane("planned-route-markers");
      markerPane.style.zIndex = "610";
      const mapSizeSync = installMapSizeSync({ map, mapNode: mapNode.current });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        subdomains: "abcd",
        maxZoom: 20,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
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
      try {
        const savedLayers = JSON.parse(localStorage.getItem("trails-route-layers") ?? "{}") as Partial<Record<Category, boolean>>;
        setEnabled((current) => {
          const next = { ...current, ...savedLayers };
          (Object.keys(categories) as Category[]).forEach((category) => {
            if (!next[category]) layersRef.current[category]?.removeFrom(map);
          });
          return next;
        });
      } catch {
        // Keep every layer visible when a saved preference is unavailable or invalid.
      }

      const updateRouteWeights = () => {
        const zoom = map.getZoom();
        (Object.keys(categories) as Category[]).forEach((category) => {
          layersRef.current[category]?.setStyle({ weight: routeWeight(category, zoom) });
        });
      };
      map.on("zoomend", updateRouteWeights);

      let hikeCount = 0;
      let bikeCount = 0;
      const updateStatus = () => {
        if (watchIdRef.current === null) setStatus(`${bikeCount.toLocaleString()} bike facilities in view · ${hikeCount.toLocaleString()} existing trail segments`);
      };

      async function loadHikes() {
        const response = await fetch(hikeUrl);
        if (!response.ok) throw new Error("Urban trail service unavailable");
        const data = (await response.json()) as ArcGISFeatureCollection;
        const features = data.features.map((feature) => ({ ...feature, properties: { ...feature.properties, category: "offRoadHike" as Category } })) as TrailFeature[];
        const collection: FeatureCollection<LineString | MultiLineString, TrailProperties> = { type: "FeatureCollection", features };
        layersRef.current.offRoadHike?.addData(collection);
        searchRecordsRef.current.offRoadHike = searchRecordsForFeatures(features);
        setSearchVersion((version) => version + 1);
        hikeCount = features.length;
        updateStatus();
      }

      async function loadBikeFacilities() {
        const visibleBounds = map.getBounds();
        if (loadedBikeBounds?.contains(visibleBounds)) return;
        bikeRequest?.abort();
        bikeRequest = new AbortController();
        const signal = bikeRequest.signal;
        if (watchIdRef.current === null) setStatus("Updating bike routes for this area…");
        const bounds = visibleBounds.pad(0.5);
        const geometry = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(",");
        const parameters = new URLSearchParams({ bounds: geometry });
        const response = await fetch(`/api/bike-facilities?${parameters}`, { signal });
        if (!response.ok) throw new Error("Bicycle facility service unavailable");
        const data = (await response.json()) as ArcGISFeatureCollection;
        const features = data.features.map((feature) => ({
          ...feature,
          properties: { ...feature.properties, category: classifyBike(feature.properties) },
        }));

        if (signal.aborted || cancelled) return;
        (["offRoadBike", "protectedBike", "streetBike"] as Category[]).forEach((category) => {
          const layer = layersRef.current[category];
          layer?.clearLayers();
          const categoryFeatures = features.filter((feature) => feature.properties.category === category);
          const collection: FeatureCollection<LineString | MultiLineString, TrailProperties> = {
            type: "FeatureCollection",
            features: categoryFeatures,
          };
          layer?.addData(collection);
          searchRecordsRef.current[category] = searchRecordsForFeatures(categoryFeatures);
        });
        setSearchVersion((version) => version + 1);
        bikeCount = features.length;
        loadedBikeBounds = bounds;
        updateStatus();
      }

      const refreshBikes = () => { loadBikeFacilities().catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("Bike routes could not update. Try refreshing when you have a connection.");
      }); };
      map.on("moveend", refreshBikes);
      map.on("click", (event) => {
        const target = activeMapTargetRef.current;
        if (!target || isRide) return;
        setPlanningEndpoint(target, {
          label: "Dropped pin",
          latitude: event.latlng.lat,
          longitude: event.latlng.lng,
        }, false);
        setActiveMapTarget(null);
      });
      loadHikes().catch(() => setStatus("Urban trails could not load. Try refreshing when you have a connection."));
      refreshBikes();
      map.once("load", mapSizeSync.syncMapSize);
      map.on("unload", mapSizeSync.disconnect);
      setMapVersion((version) => version + 1);
    }

    start();
    return () => {
      cancelled = true;
      bikeRequest?.abort();
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      leafletRef.current = null;
      planningEndpointMarkersRef.current = {};
      guidanceDestinationMarkerRef.current = null;
      plannedRouteLayerRef.current = null;
      divergenceLayerRef.current = null;
    };
  }, [isRide]);

  useEffect(() => {
    if (!isRide) return;
    const guidanceTimer = window.setTimeout(() => {
      const guidance = loadRouteGuidance(sessionStorage) as RouteGuidance | null;
      activeGuidanceRef.current = guidance;
      setActiveGuidance(guidance);
      const progress = guidance ? initialGuidanceProgress(guidance.route) : null;
      guidanceProgressRef.current = progress;
      setGuidanceProgress(progress);
      const offRoute = initialOffRouteState();
      offRouteStateRef.current = offRoute;
      setOffRouteState(offRoute);
    }, 0);
    const recorder = new RideRecorder();
    rideRecorderRef.current = recorder;
    recorder.activeRide().then((ride) => setHasInterruptedRide(Boolean(ride))).catch(() => {});
    return () => {
      window.clearTimeout(guidanceTimer);
      rideRecorderRef.current = null;
    };
  }, [isRide]);

  useEffect(() => () => {
    rerouteControllerRef.current?.abort();
    if (rerouteFreshnessTimerRef.current !== null) {
      window.clearTimeout(rerouteFreshnessTimerRef.current);
    }
  }, []);

  useEffect(() => {
    activeMapTargetRef.current = activeMapTarget;
  }, [activeMapTarget]);

  useEffect(() => {
    planningEndpointsRef.current = planningEndpoints;
  }, [planningEndpoints]);

  useEffect(() => {
    if (isRide) return;
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L) return;
    (["start", "destination"] as PlanningEndpointKey[]).forEach((target) => {
      planningEndpointMarkersRef.current[target]?.remove();
      delete planningEndpointMarkersRef.current[target];
      const endpoint = planningEndpoints[target];
      if (!endpoint) return;
      const icon = L.divIcon({
        className: "planner-marker-wrapper",
        html: `<span class="planner-marker ${target}" aria-hidden="true"><b>${target === "start" ? "A" : "B"}</b></span>`,
        iconSize: [34, 42],
        iconAnchor: [17, 39],
      });
      const marker = L.marker([endpoint.latitude, endpoint.longitude], {
        draggable: true,
        icon,
        keyboard: true,
        pane: "planned-route-markers",
        title: `${target === "start" ? "Start" : "Destination"}: ${endpoint.label}. Drag to adjust.`,
      }).addTo(map);
      marker.on("dragend", () => {
        const point = marker.getLatLng();
        setPlanningEndpoint(target, {
          label: "Dropped pin",
          latitude: point.lat,
          longitude: point.lng,
        }, false);
      });
      planningEndpointMarkersRef.current[target] = marker;
    });
  }, [isRide, mapVersion, planningEndpoints]);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L) return;
    const displayedRoute = isRide ? activeGuidance?.route : plannedRoute;
    plannedRouteLayerRef.current?.remove();
    divergenceLayerRef.current?.remove();
    plannedRouteLayerRef.current = null;
    divergenceLayerRef.current = null;
    if (!displayedRoute) return;

    plannedRouteLayerRef.current = L.geoJSON(displayedRoute.geometry, {
      style: {
        pane: "planned-route",
        color: "#203b31",
        opacity: 0.94,
        weight: 6,
        lineCap: "round",
        lineJoin: "round",
      },
    }).addTo(map);
    divergenceLayerRef.current = L.geoJSON({
      type: "FeatureCollection",
      features: displayedRoute.divergences.map((divergence) => ({
        type: "Feature",
        properties: {},
        geometry: divergence.geometry,
      })),
    }, {
      style: {
        pane: "planned-route",
        color: "#d4512d",
        opacity: 1,
        weight: 7,
        dashArray: "9 7",
        lineCap: "round",
      },
    }).addTo(map);
    const bounds = plannedRouteLayerRef.current.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [36, 36], maxZoom: 16 });
  }, [activeGuidance, isRide, mapVersion, plannedRoute]);

  useEffect(() => {
    if (!isRide) return;
    const map = mapRef.current;
    const L = leafletRef.current;
    guidanceDestinationMarkerRef.current?.remove();
    guidanceDestinationMarkerRef.current = null;
    if (!map || !L || !activeGuidance) return;
    const destination = activeGuidance.endpoints.destination;
    const icon = L.divIcon({
      className: "planner-marker-wrapper",
      html: '<span class="planner-marker destination" aria-hidden="true"><b>B</b></span>',
      iconSize: [34, 42],
      iconAnchor: [17, 39],
    });
    guidanceDestinationMarkerRef.current = L.marker(
      [destination.latitude, destination.longitude],
      {
        icon,
        keyboard: true,
        pane: "planned-route-markers",
        title: `Destination: ${destination.label}`,
      },
    ).addTo(map);
  }, [activeGuidance, isRide, mapVersion]);

  function setPlanningEndpoint(
    target: PlanningEndpointKey,
    point: PlanningPoint | null,
    moveMap = true,
  ) {
    const next = { ...planningEndpointsRef.current, [target]: point };
    planningEndpointsRef.current = next;
    setPlanningEndpoints(next);
    setPlannedRoute(null);
    if (!point || !moveMap) return;
    const map = mapRef.current;
    if (!map) return;
    const other = next[target === "start" ? "destination" : "start"];
    if (other) {
      map.fitBounds([
        [point.latitude, point.longitude],
        [other.latitude, other.longitude],
      ], { padding: [44, 44], maxZoom: 16 });
    } else {
      map.setView([point.latitude, point.longitude], Math.max(map.getZoom(), 15), { animate: true });
    }
  }

  function swapPlanningEndpoints() {
    const next = {
      start: planningEndpointsRef.current.destination,
      destination: planningEndpointsRef.current.start,
    };
    planningEndpointsRef.current = next;
    setPlanningEndpoints(next);
    setPlannedRoute(null);
    setActiveMapTarget(null);
  }

  function startGuidance(safetyPreference: string) {
    const start = planningEndpoints.start;
    const destination = planningEndpoints.destination;
    if (!plannedRoute || !start || !destination) {
      throw new Error("A planned route is required before guidance can start.");
    }
    saveRouteGuidance(sessionStorage, {
      safetyPreference,
      endpoints: { start, destination },
      route: plannedRoute,
    });
    window.location.assign("/ride");
  }

  function choosePlanningPointAtMapCenter() {
    const map = mapRef.current;
    if (!map || !activeMapTarget) return;
    const center = map.getCenter();
    setPlanningEndpoint(activeMapTarget, {
      label: "Dropped pin",
      latitude: center.lat,
      longitude: center.lng,
    }, false);
    setActiveMapTarget(null);
  }

  function toggle(category: Category) {
    const next = !enabled[category];
    setEnabled((current) => {
      const updated = { ...current, [category]: next };
      try {
        localStorage.setItem("trails-route-layers", JSON.stringify(updated));
      } catch {
        // Layer preferences are optional.
      }
      return updated;
    });
    const map = mapRef.current;
    const layer = layersRef.current[category];
    if (map && layer) {
      if (next) layer.addTo(map);
      else layer.removeFrom(map);
    }
  }

  async function requestWakeLock() {
    const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!wakeLock || document.visibilityState !== "visible") return;
    try {
      const sentinel = await wakeLock.request("screen");
      wakeLockRef.current = sentinel;
      setWakeLockActive(true);
      sentinel.addEventListener("release", () => setWakeLockActive(false), { once: true });
    } catch {
      setWakeLockActive(false);
    }
  }

  function appendDiagnostic(sample: DiagnosticSample) {
    diagnosticsRef.current = [...diagnosticsRef.current.slice(-599), sample];
    setDiagnosticCount(diagnosticsRef.current.length);
  }

  function stopTracking() {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    watchIdRef.current = null;
    setTracking(false);
    clearRouteGuidance(sessionStorage);
    setActiveGuidance(null);
    activeGuidanceRef.current = null;
    guidanceProgressRef.current = null;
    setGuidanceProgress(null);
    const offRoute = initialOffRouteState();
    offRouteStateRef.current = offRoute;
    setOffRouteState(offRoute);
    lastGuidancePointRef.current = null;
    if (rerouteFreshnessTimerRef.current !== null) {
      window.clearTimeout(rerouteFreshnessTimerRef.current);
      rerouteFreshnessTimerRef.current = null;
    }
    setRerouteFixFresh(false);
    rerouteControllerRef.current?.abort();
    rerouteControllerRef.current = null;
    setRerouting(false);
    setRerouteMessage("");
    setOrientation("north");
    const map = mapRef.current;
    locationMarkerRef.current?.remove();
    accuracyCircleRef.current?.remove();
    locationMarkerRef.current = null;
    accuracyCircleRef.current = null;
    lastLocationRef.current = null;
    lastAccuracyRef.current = null;
    lastTimestampRef.current = null;
    lastHeadingRef.current = null;
    wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    setWakeLockActive(false);
    map?.setBearing(0);
    setBearing(0);
    setGpsQuality("idle");
    setStatus("Saving route history…");
    rideRecorderRef.current?.finish()
      .then(() => { setHasInterruptedRide(false); setStatus("Ride mode stopped and saved"); })
      .catch(() => setStatus("Ride stopped. Route points will retry when you resume."));
  }

  async function rerouteFromLastTrustworthyFix() {
    const guidance = activeGuidanceRef.current;
    const point = lastGuidancePointRef.current;
    if (!guidance || !point || rerouting) return;
    if (!rerouteFixIsFresh(point)) {
      setRerouteFixFresh(false);
      setRerouteMessage("");
      return;
    }
    rerouteControllerRef.current?.abort();
    const controller = new AbortController();
    rerouteControllerRef.current = controller;
    setRerouting(true);
    setRerouteMessage("");
    try {
      const response = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(rerouteRequest(guidance, point)),
        signal: controller.signal,
      });
      const value: unknown = await response.json().catch(() => ({}));
      if (rerouteControllerRef.current !== controller || controller.signal.aborted) return;
      if (!rerouteFixIsFresh(point)) {
        setRerouteFixFresh(false);
        setRerouteMessage("");
        return;
      }
      if (!response.ok) {
        setRerouteMessage(routeErrorMessage(response.status, value));
        return;
      }
      const route = normalizePlannedRoute(value);
      const nextGuidance = saveRouteGuidance(sessionStorage, {
        safetyPreference: guidance.safetyPreference,
        endpoints: {
          start: { label: "Current location", latitude: point.latitude, longitude: point.longitude },
          destination: guidance.endpoints.destination,
        },
        route,
      }) as RouteGuidance;
      activeGuidanceRef.current = nextGuidance;
      setActiveGuidance(nextGuidance);
      const progress = initialGuidanceProgress(route);
      guidanceProgressRef.current = progress;
      setGuidanceProgress(progress);
      const offRoute = initialOffRouteState();
      offRouteStateRef.current = offRoute;
      setOffRouteState(offRoute);
      setRerouteMessage("");
      setStatus("Ride mode · New route ready from your last trustworthy position");
    } catch (error) {
      if (controller.signal.aborted) return;
      setRerouteMessage(error instanceof Error && error.message.startsWith("Route response")
        ? "The routing service returned an unusable route. Try again."
        : "Rerouting is temporarily unavailable. Keep riding safely and try again.");
    } finally {
      if (rerouteControllerRef.current === controller) {
        rerouteControllerRef.current = null;
        setRerouting(false);
      }
    }
  }

  async function beginRide() {
    setCheckingIdentity(true);
    try {
      const { user } = await ensureUser();
      if (user.accountType === "registered") {
        startTracking();
        return;
      }
      setShowLoginReminder(true);
    } catch {
      // Do not block a ride when the optional account check is unavailable.
      setShowLoginReminder(true);
    } finally {
      setCheckingIdentity(false);
    }
  }

  function continueAnonymously() {
    setShowLoginReminder(false);
    startTracking();
  }

  function startTracking() {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L) return;
    if (!navigator.geolocation) {
      setStatus("This browser does not support location tracking.");
      return;
    }
    if (watchIdRef.current !== null) return;
    setTracking(true);
    const offRoute = initialOffRouteState();
    offRouteStateRef.current = offRoute;
    setOffRouteState(offRoute);
    setRerouteFixFresh(false);
    setRerouteMessage("");
    setGpsQuality("acquiring");
    setStatus("Starting high-accuracy GPS…");
    requestWakeLock();
    let firstFix = true;
    watchIdRef.current = navigator.geolocation.watchPosition((position) => {
      const ageMs = Math.max(0, Date.now() - position.timestamp);
      const roundedAccuracy = Math.round(position.coords.accuracy);
      const quality = locationQuality(position.coords.accuracy, ageMs);
      const fixAction = locationFixAction(position.coords.accuracy, !firstFix, ageMs);
      const baseSample = {
        accuracy: position.coords.accuracy,
        heading: Number.isFinite(position.coords.heading) ? position.coords.heading : null,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        quality,
        speed: Number.isFinite(position.coords.speed) ? position.coords.speed : null,
        timestamp: position.timestamp,
        visibility: document.visibilityState,
      };
      if (fixAction === "wait-for-accurate-fix") {
        appendDiagnostic({ ...baseSample, accepted: false, action: fixAction });
        setGpsQuality("unusable");
        setStatus(`Ride mode · GPS ±${roundedAccuracy} m is approximate · Enable Precise or Accurate Location in your phone's browser settings`);
        return;
      }
      if (fixAction === "keep-last-fix") {
        appendDiagnostic({ ...baseSample, accepted: false, action: fixAction });
        setGpsQuality("unusable");
        setStatus(`Ride mode · GPS weakened to ±${roundedAccuracy} m · Keeping your last accurate position`);
        return;
      }

      const rawLatLng = L.latLng(position.coords.latitude, position.coords.longitude);
      const previous = lastLocationRef.current;
      const rawDistance = previous?.distanceTo(rawLatLng) ?? 0;
      const elapsedMs = lastTimestampRef.current === null ? 0 : position.timestamp - lastTimestampRef.current;
      if (previous && lastAccuracyRef.current !== null && !isPlausibleLocationChange(rawDistance, elapsedMs, lastAccuracyRef.current, position.coords.accuracy)) {
        appendDiagnostic({ ...baseSample, accepted: false, action: "reject-jump" });
        setStatus(`Ride mode · Ignored a GPS jump · Signal ±${roundedAccuracy} m`);
        return;
      }
      const weight = smoothingWeight(position.coords.accuracy);
      const latlng = previous
        ? L.latLng(previous.lat + (rawLatLng.lat - previous.lat) * weight, previous.lng + (rawLatLng.lng - previous.lng) * weight)
        : rawLatLng;
      const moved = previous?.distanceTo(latlng) ?? 0;
      const measuredHeading = Number.isFinite(position.coords.heading) ? position.coords.heading : null;
      const derivedHeading = previous && moved >= 4 ? bearingBetween(previous, latlng) : null;
      const heading = measuredHeading ?? derivedHeading ?? lastHeadingRef.current;
      if (heading !== null) lastHeadingRef.current = heading;
      lastLocationRef.current = latlng;
      lastAccuracyRef.current = position.coords.accuracy;
      lastTimestampRef.current = position.timestamp;
      appendDiagnostic({ ...baseSample, accepted: true, action: "use-fix" });
      const currentGuidance = activeGuidanceRef.current;
      if (currentGuidance && guidanceQualityCanAdvance(quality)) {
        const hasPreviousGuidanceFix = lastGuidancePointRef.current !== null;
        const guidancePoint = {
          accuracyMeters: position.coords.accuracy,
          latitude: latlng.lat,
          longitude: latlng.lng,
          timestamp: position.timestamp,
        };
        lastGuidancePointRef.current = guidancePoint;
        const previousProgress = guidanceProgressRef.current
          ?? initialGuidanceProgress(currentGuidance.route);
        const nextProgress = updateGuidanceProgress(
          currentGuidance.route,
          previousProgress,
          guidancePoint,
        );
        const nextOffRouteState = updateOffRouteState(
          currentGuidance.route,
          offRouteStateRef.current,
          guidancePoint,
          hasPreviousGuidanceFix ? previousProgress.progressMiles : nextProgress.progressMiles,
        );
        offRouteStateRef.current = nextOffRouteState;
        setOffRouteState(nextOffRouteState);
        const trustedProgress = guidanceProgressAfterOffRouteCheck(
          previousProgress,
          nextProgress,
          nextOffRouteState,
        );
        guidanceProgressRef.current = trustedProgress;
        setGuidanceProgress(trustedProgress);
        setRerouteFixFresh(true);
        if (rerouteFreshnessTimerRef.current !== null) {
          window.clearTimeout(rerouteFreshnessTimerRef.current);
        }
        const freshnessRemainingMs = Math.max(
          0,
          MAX_FIX_AGE_MS - Math.max(0, Date.now() - position.timestamp),
        );
        rerouteFreshnessTimerRef.current = window.setTimeout(() => {
          setRerouteFixFresh(false);
          rerouteFreshnessTimerRef.current = null;
        }, freshnessRemainingMs);
      }
      rideRecorderRef.current?.record({
        recordedAt: position.timestamp,
        latitude: latlng.lat,
        longitude: latlng.lng,
        accuracyMeters: position.coords.accuracy,
        altitudeMeters: Number.isFinite(position.coords.altitude) ? position.coords.altitude : null,
        speedMetersPerSecond: Number.isFinite(position.coords.speed) ? position.coords.speed : null,
        headingDegrees: heading,
        quality,
      }).catch(() => setStatus("Ride mode · route history is queued on this device"));
      setGpsQuality(quality);

      if (!locationMarkerRef.current) {
        locationMarkerRef.current = L.circleMarker(latlng, { radius: 8, color: "#fffaf0", weight: 3, fillColor: "#236e9b", fillOpacity: 1 }).addTo(map);
        accuracyCircleRef.current = L.circle(latlng, { radius: position.coords.accuracy, color: "#236e9b", weight: 1, opacity: 0.5, fillColor: "#4d9fc4", fillOpacity: 0.12 }).addTo(map);
      } else {
        locationMarkerRef.current.setLatLng(latlng);
        accuracyCircleRef.current?.setLatLng(latlng).setRadius(position.coords.accuracy);
      }

      if (firstFix) {
        map.setView(latlng, Math.max(map.getZoom(), 16), { animate: true });
        firstFix = false;
      } else {
        map.panTo(latlng, { animate: true, duration: 0.45 });
      }
      if (orientationRef.current === "forward" && heading !== null) {
        const nextBearing = nextForwardMapBearing(map.getBearing(), heading);
        map.setBearing(nextBearing);
        setBearing(nextBearing);
      }
      const speed = position.coords.speed && position.coords.speed > 0 ? ` · ${(position.coords.speed * 2.237).toFixed(1)} mph` : "";
      setStatus(`Ride mode · GPS ±${roundedAccuracy} m${speed}`);
    }, (error) => {
      if (error.code === error.PERMISSION_DENIED) {
        if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
        setTracking(false);
        setGpsQuality("blocked");
        setStatus("Location access is needed for ride mode.");
      } else {
        setGpsQuality("unusable");
        setStatus("Ride mode · waiting for a stronger GPS signal…");
      }
    }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 12000 });
  }

  function setOrientation(next: Orientation) {
    orientationRef.current = next;
    setOrientationState(next);
    const map = mapRef.current;
    if (!map) return;
    if (next === "north") {
      map.setBearing(0);
      setBearing(0);
    } else if (lastHeadingRef.current !== null) {
      const bearing = forwardMapBearing(lastHeadingRef.current);
      map.setBearing(bearing);
      setBearing(bearing);
    }
  }

  function chooseSearchResult(result: SearchRecord) {
    const map = mapRef.current;
    if (!map) return;
    if (!enabled[result.category]) toggle(result.category);
    map.setView([result.latitude, result.longitude], 16, { animate: true });
    setSearchQuery(result.label);
  }

  function downloadDiagnostics() {
    if (diagnosticsRef.current.length === 0) return;
    const payload = {
      createdAt: new Date().toISOString(),
      device: navigator.userAgent,
      note: "Location samples remain on this device unless you choose to share this downloaded file.",
      samples: diagnosticsRef.current,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `austin-trails-gps-${new Date().toISOString().replaceAll(":", "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function clearDiagnostics() {
    diagnosticsRef.current = [];
    setDiagnosticCount(0);
  }

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const searchResults = normalizedSearch.length < 2
    ? []
    : Object.values(searchRecordsRef.current)
      .flat()
      .filter((record) => `${record.label} ${record.detail}`.toLowerCase().includes(normalizedSearch))
      .filter((record, index, records) => records.findIndex((candidate) => candidate.label === record.label && candidate.category === record.category) === index)
      .slice(0, 6);
  const activeManeuver = activeGuidance && guidanceProgress && guidanceProgress.maneuverIndex !== null
    ? activeGuidance.route.maneuvers[guidanceProgress.maneuverIndex] ?? null
    : null;
  const startGpsLabel = `${hasInterruptedRide ? "Resume" : "Start"} GPS${activeGuidance ? " guidance" : ""}`;

  return (
    <main className={isRide ? "ride-shell" : "trails-shell"}>
      {!isRide && (
        <header className="trails-header">
          <div>
            <p className="eyebrow">Field guide · Austin, Texas</p>
            <h1>Austin Trails</h1>
          </div>
          <div className="trails-header-actions">
            <nav className="trails-account-nav" aria-label="Private account and history">
              <Link href="/history">History</Link>
              <Link href="/account">Account</Link>
            </nav>
            <Link className="location-button" href="/ride" aria-label="Open full-screen ride map">
              <span className="location-button-icon" aria-hidden="true" />
              <span className="location-button-label">Start ride</span>
            </Link>
          </div>
        </header>
      )}

      {!isRide && (
        <section className="search-panel" aria-label="Find a trail or street">
          <label htmlFor="trail-search">Find a trail or bike route</label>
          <div className="search-field">
            <span aria-hidden="true">⌕</span>
            <input
              id="trail-search"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search by trail, street, or facility type"
              autoComplete="off"
            />
          </div>
          {normalizedSearch.length >= 2 && (
            <div className="search-results" role="listbox" aria-label="Matching trails and bike routes">
              {searchResults.length > 0 ? searchResults.map((result) => (
                <button key={`${result.category}-${result.label}`} role="option" aria-selected="false" onClick={() => chooseSearchResult(result)}>
                  <strong>{result.label}</strong>
                  <span><i style={{ background: categories[result.category].color }} />{categories[result.category].label} · {result.detail}</span>
                </button>
              )) : <p>Move the map toward the area you want to search, then try again.</p>}
            </div>
          )}
        </section>
      )}

      <div className={isRide ? "ride-map-layout" : "trails-planning-layout"}>
        {!isRide && (
          <RoutePlanner
            activeMapTarget={activeMapTarget}
            endpoints={planningEndpoints}
            plannedRoute={plannedRoute}
            onEndpointChange={setPlanningEndpoint}
            onMapTargetChange={setActiveMapTarget}
            onRouteChange={setPlannedRoute}
            onStartGuidance={startGuidance}
            onSwapEndpoints={swapPlanningEndpoints}
          />
        )}
        <section className={isRide ? "ride-map-frame" : "map-frame"} aria-label={isRide ? "Full-screen moving ride map" : "Interactive map of Austin hike and bike paths"}>
        <div ref={mapNode} className={activeMapTarget ? "map map-picking" : "map"} />
        {isRide && (
          <div className="ride-topbar">
            <Link href="/" className="ride-exit" aria-label="Exit ride mode">← <span>Trails</span></Link>
            <div className={`gps-badge ${gpsQuality}`} aria-live="polite">
              <span className="stamp-dot" />{status}
            </div>
            <button className="ride-more" onClick={() => setShowDiagnostics((shown) => !shown)} aria-expanded={showDiagnostics} aria-label="GPS diagnostics">•••</button>
          </div>
        )}
        {!isRide && <div className="map-stamp" aria-live="polite"><span className="stamp-dot" />{status}</div>}
        {!isRide && activeMapTarget && (
          <div className="map-pick-prompt" role="status">
            <span>Choose the {activeMapTarget === "start" ? "start" : "destination"} on the map</span>
            <button type="button" onClick={choosePlanningPointAtMapCenter}>Use map center</button>
            <button type="button" onClick={() => setActiveMapTarget(null)}>Cancel</button>
          </div>
        )}
        {isRide && !tracking && (
          <div className="ride-start-card">
            <p className="eyebrow">{activeGuidance ? "Guidance ready" : "Full-screen navigation"}</p>
            <h1>{activeGuidance ? `Ride to ${activeGuidance.endpoints.destination.label}` : "Ready to ride?"}</h1>
            <p>{activeGuidance
              ? `${formatMiles(activeGuidance.route.totalMiles)} remaining on the highlighted route.`
              : "Keep the phone in view and allow precise location. Accepted route points are saved to your private route history."}</p>
            {activeGuidance && (
              <div className="ride-first-maneuver">
                <span>First direction</span>
                <strong>{activeManeuver?.instruction ?? "Follow the highlighted route."}</strong>
                {activeManeuver && <small>{formatMiles(activeManeuver.distanceMiles)}</small>}
              </div>
            )}
            {activeGuidance && <p>Allow precise location when you start. Only accepted GPS fixes will move the map or be saved to your private route history.</p>}
            {hasInterruptedRide && <p>Your last interrupted ride is ready to resume; queued points will upload when you reconnect.</p>}
            {showLoginReminder ? (
              <div className="ride-login-reminder" role="dialog" aria-labelledby="ride-login-reminder-title">
                <h2 id="ride-login-reminder-title">Save rides beyond this browser</h2>
                <p>Sign in to keep your ride history when you change phones or browsers. You can also continue with private browser-only history.</p>
                <Link className="ride-login-link" href="/account?returnTo=/ride">Sign in</Link>
                <button className="ride-continue-anonymously" onClick={continueAnonymously}>Continue without signing in</button>
              </div>
            ) : <button onClick={beginRide} disabled={checkingIdentity}>{checkingIdentity ? "Checking account…" : startGpsLabel}</button>}
            <Link href="/">Return to Trails</Link>
          </div>
        )}
        {isRide && tracking && activeGuidance && (
          <RouteGuidanceCard
            destinationLabel={activeGuidance.endpoints.destination.label}
            maneuver={activeManeuver}
            progress={guidanceProgress}
            totalMiles={activeGuidance.route.totalMiles}
          />
        )}
        {isRide && tracking && activeGuidance && offRouteState.status === "off-route" && (
          <RouteOffRouteAlert
            busy={rerouting}
            fixFresh={rerouteFixFresh}
            message={rerouteMessage}
            onReroute={rerouteFromLastTrustworthyFix}
          />
        )}
        {tracking && (
          <div className="orientation-control" role="group" aria-label="Map orientation">
            <button className={orientation === "north" ? "active" : ""} onClick={() => setOrientation("north")} aria-pressed={orientation === "north"}>N↑ <span>North up</span></button>
            <button className={orientation === "forward" ? "active" : ""} onClick={() => setOrientation("forward")} aria-pressed={orientation === "forward"}>➤ <span>Forward up</span></button>
          </div>
        )}
        {isRide && tracking && <button className="ride-stop" onClick={stopTracking}>■ Stop ride</button>}
        {isRide && showDiagnostics && (
          <aside className="diagnostics-panel" aria-label="GPS diagnostics">
            <div>
              <p className="eyebrow">Device-local diagnostics</p>
              <h2>GPS samples</h2>
            </div>
            <dl>
              <div><dt>Samples</dt><dd>{diagnosticCount}</dd></div>
              <div><dt>Signal</dt><dd>{gpsQuality}</dd></div>
              <div><dt>Screen awake</dt><dd>{wakeLockActive ? "On" : "Unavailable"}</dd></div>
            </dl>
            <p>Export this after a test ride to diagnose accuracy, timing, and rejected jumps. Nothing is uploaded automatically.</p>
            <div className="diagnostic-actions">
              <button onClick={downloadDiagnostics} disabled={diagnosticCount === 0}>Download log</button>
              <button onClick={clearDiagnostics} disabled={diagnosticCount === 0}>Clear</button>
            </div>
          </aside>
        )}
        <div className="north-mark" style={{ transform: `rotate(${-bearing}deg)` }} aria-hidden="true">N<span>↑</span></div>
        </section>
      </div>

      <aside className={isRide ? "ride-layers" : "legend"} aria-label="Trail type and safety legend">
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
