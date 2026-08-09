"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { locationFixAction } from "./location-accuracy";
import {
  formatFeet,
  formatMiles,
  nextComboboxOptionIndex,
  normalizePlannedRoute,
  routeErrorMessage,
  routeRequestIsCurrent,
  SAFETY_CLASS_LABELS,
  SAFETY_OPTIONS,
  swapEndpointQueries,
} from "./route-planner-utils.js";

export type PlanningEndpointKey = "start" | "destination";
export type PlanningPoint = {
  label: string;
  latitude: number;
  longitude: number;
};
export type PlannedRoute = ReturnType<typeof normalizePlannedRoute>;
export type PlanningEndpoints = Record<PlanningEndpointKey, PlanningPoint | null>;

type GeocodeResult = PlanningPoint & { id: string; category: string; type: string };
type PlannerProps = {
  activeMapTarget: PlanningEndpointKey | null;
  endpoints: PlanningEndpoints;
  plannedRoute: PlannedRoute | null;
  onEndpointChange: (target: PlanningEndpointKey, point: PlanningPoint | null) => void;
  onMapTargetChange: (target: PlanningEndpointKey | null) => void;
  onRouteChange: (route: PlannedRoute | null) => void;
  onStartGuidance: (safetyPreference: string) => void;
  onSwapEndpoints: () => void;
};

function geocodeResults(value: unknown): { results: GeocodeResult[]; attribution: string } {
  if (!value || typeof value !== "object") return { results: [], attribution: "" };
  const response = value as { results?: unknown; attribution?: unknown };
  if (!Array.isArray(response.results)) return { results: [], attribution: "" };
  const results = response.results.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const result = item as Record<string, unknown>;
    const latitude = Number(result.latitude);
    const longitude = Number(result.longitude);
    const label = String(result.label ?? "").trim();
    if (!label || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    return [{
      id: String(result.id ?? `${latitude},${longitude}`),
      label,
      latitude,
      longitude,
      category: String(result.category ?? "place"),
      type: String(result.type ?? "place"),
    }];
  });
  return {
    results,
    attribution: typeof response.attribution === "string" ? response.attribution : "",
  };
}

export default function RoutePlanner({
  activeMapTarget,
  endpoints,
  plannedRoute,
  onEndpointChange,
  onMapTargetChange,
  onRouteChange,
  onStartGuidance,
  onSwapEndpoints,
}: PlannerProps) {
  const [queries, setQueries] = useState<Record<PlanningEndpointKey, string>>({
    start: "",
    destination: "",
  });
  const [safetyPreference, setSafetyPreference] = useState("bike-facility-or-safer");
  const [search, setSearch] = useState<{
    target: PlanningEndpointKey;
    results: GeocodeResult[];
    attribution: string;
    activeResultIndex: number;
  } | null>(null);
  const [busy, setBusy] = useState<PlanningEndpointKey | "route" | "location" | null>(null);
  const [message, setMessage] = useState("");
  const routeRequestRef = useRef<AbortController | null>(null);
  const locationWatchRef = useRef<number | null>(null);
  const locationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    routeRequestRef.current?.abort();
    if (locationWatchRef.current !== null) navigator.geolocation.clearWatch(locationWatchRef.current);
    if (locationTimeoutRef.current !== null) clearTimeout(locationTimeoutRef.current);
  }, []);

  useEffect(() => {
    const controller = routeRequestRef.current;
    if (!controller) return;
    routeRequestRef.current = null;
    controller.abort();
    setBusy((current) => current === "route" ? null : current);
  }, [
    endpoints.start?.latitude,
    endpoints.start?.longitude,
    endpoints.destination?.latitude,
    endpoints.destination?.longitude,
  ]);

  function invalidateRouteRequest() {
    const controller = routeRequestRef.current;
    routeRequestRef.current = null;
    controller?.abort();
    setBusy((current) => current === "route" ? null : current);
  }

  async function searchAddress(event: FormEvent, target: PlanningEndpointKey) {
    event.preventDefault();
    const query = queries[target].trim();
    if (query.length < 2) {
      setMessage("Enter at least two characters, then submit the address search.");
      return;
    }
    setBusy(target);
    setMessage("");
    setSearch(null);
    try {
      const parameters = new URLSearchParams({ q: query, limit: "5" });
      const response = await fetch(`/api/geocode?${parameters}`, {
        headers: { Accept: "application/json" },
      });
      const value: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(response.status === 503
          ? "Address search is not available in this environment yet."
          : "Address search is temporarily unavailable. Try again shortly.");
        return;
      }
      const normalized = geocodeResults(value);
      setSearch({
        target,
        ...normalized,
        activeResultIndex: normalized.results.length > 0 ? 0 : -1,
      });
      if (normalized.results.length === 0) {
        setMessage("No Austin-area matches were found. Try a more specific address or place.");
      }
    } catch {
      setMessage("Address search is temporarily unavailable. Try again shortly.");
    } finally {
      setBusy(null);
    }
  }

  function chooseResult(target: PlanningEndpointKey, result: GeocodeResult) {
    invalidateRouteRequest();
    onEndpointChange(target, result);
    setQueries((current) => ({ ...current, [target]: result.label }));
    setSearch(null);
    setMessage("");
    onMapTargetChange(null);
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>, target: PlanningEndpointKey) {
    if (search?.target !== target) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setSearch(null);
      return;
    }
    if (event.key === "Enter" && search.results[search.activeResultIndex]) {
      event.preventDefault();
      chooseResult(target, search.results[search.activeResultIndex]);
      return;
    }
    const nextIndex = nextComboboxOptionIndex(
      search.results.length,
      search.activeResultIndex,
      event.key,
    );
    if (nextIndex === null) return;
    event.preventDefault();
    setSearch((current) => current?.target === target
      ? { ...current, activeResultIndex: nextIndex }
      : current);
  }

  function clearEndpoint(target: PlanningEndpointKey) {
    invalidateRouteRequest();
    onEndpointChange(target, null);
    setQueries((current) => ({ ...current, [target]: "" }));
    if (search?.target === target) setSearch(null);
    if (activeMapTarget === target) onMapTargetChange(null);
    setMessage("");
  }

  function chooseMyLocation(target: PlanningEndpointKey) {
    if (!navigator.geolocation) {
      setMessage("This browser does not support location access.");
      return;
    }
    if (locationWatchRef.current !== null) navigator.geolocation.clearWatch(locationWatchRef.current);
    if (locationTimeoutRef.current !== null) clearTimeout(locationTimeoutRef.current);
    setBusy("location");
    setMessage("Waiting for a usable location fix…");
    locationWatchRef.current = navigator.geolocation.watchPosition((position) => {
      const ageMs = Math.max(0, Date.now() - position.timestamp);
      if (locationFixAction(position.coords.accuracy, false, ageMs) !== "use-fix") return;
      if (locationWatchRef.current !== null) navigator.geolocation.clearWatch(locationWatchRef.current);
      locationWatchRef.current = null;
      if (locationTimeoutRef.current !== null) clearTimeout(locationTimeoutRef.current);
      locationTimeoutRef.current = null;
      const point = {
        label: `My location (±${Math.round(position.coords.accuracy)} m)`,
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };
      invalidateRouteRequest();
      onEndpointChange(target, point);
      setQueries((current) => ({ ...current, [target]: point.label }));
      setBusy(null);
      setMessage("");
      onMapTargetChange(null);
    }, (error) => {
      if (locationWatchRef.current !== null) navigator.geolocation.clearWatch(locationWatchRef.current);
      locationWatchRef.current = null;
      if (locationTimeoutRef.current !== null) clearTimeout(locationTimeoutRef.current);
      locationTimeoutRef.current = null;
      setBusy(null);
      setMessage(error.code === error.PERMISSION_DENIED
        ? "Allow precise location access to use your position."
        : "A usable location fix was not available. Try choosing a point on the map.");
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 });
    locationTimeoutRef.current = setTimeout(() => {
      if (locationWatchRef.current !== null) navigator.geolocation.clearWatch(locationWatchRef.current);
      locationWatchRef.current = null;
      locationTimeoutRef.current = null;
      setBusy(null);
      setMessage("A usable location fix was not available. Try choosing a point on the map.");
    }, 16_000);
  }

  async function planRoute(event: FormEvent) {
    event.preventDefault();
    if (!endpoints.start || !endpoints.destination) {
      setMessage("Set both a start and destination before planning a route.");
      return;
    }
    routeRequestRef.current?.abort();
    const controller = new AbortController();
    routeRequestRef.current = controller;
    setBusy("route");
    setMessage("");
    onRouteChange(null);
    try {
      const response = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          start: {
            latitude: endpoints.start.latitude,
            longitude: endpoints.start.longitude,
          },
          destination: {
            latitude: endpoints.destination.latitude,
            longitude: endpoints.destination.longitude,
          },
          safetyPreference,
        }),
        signal: controller.signal,
      });
      const value: unknown = await response.json().catch(() => ({}));
      if (!routeRequestIsCurrent(routeRequestRef.current, controller)) return;
      if (!response.ok) {
        setMessage(routeErrorMessage(response.status, value));
        return;
      }
      onRouteChange(normalizePlannedRoute(value));
    } catch (error) {
      if (!routeRequestIsCurrent(routeRequestRef.current, controller)) return;
      setMessage(error instanceof Error && error.message.startsWith("Route response")
        ? "The routing service returned an unusable route. Try again shortly."
        : "Route planning is temporarily unavailable. Try again shortly.");
    } finally {
      if (routeRequestRef.current === controller) {
        routeRequestRef.current = null;
        setBusy(null);
      }
    }
  }

  function swapEndpoints() {
    invalidateRouteRequest();
    setQueries(swapEndpointQueries);
    setSearch(null);
    setMessage("");
    onSwapEndpoints();
  }

  function startGuidance() {
    try {
      onStartGuidance(safetyPreference);
    } catch {
      setMessage("Guidance could not be started in this browser. Try planning the route again.");
    }
  }

  function endpointEditor(target: PlanningEndpointKey, label: string) {
    const endpoint = endpoints[target];
    const choosingOnMap = activeMapTarget === target;
    const hasSearchResults = search?.target === target && search.results.length > 0;
    const resultsId = `planner-${target}-matches`;
    const activeResultId = hasSearchResults && search.results[search.activeResultIndex]
      ? `${resultsId}-${search.activeResultIndex}`
      : undefined;
    return (
      <div className="planner-endpoint">
        <div className="planner-endpoint-heading">
          <label htmlFor={`planner-${target}`}>{label}</label>
          {endpoint && <button type="button" className="planner-text-action" onClick={() => clearEndpoint(target)}>Clear</button>}
        </div>
        <form className="planner-search" onSubmit={(event) => searchAddress(event, target)}>
          <input
            id={`planner-${target}`}
            type="search"
            value={queries[target]}
            onChange={(event) => setQueries((current) => ({ ...current, [target]: event.target.value }))}
            placeholder={`Search ${label.toLowerCase()} address or place`}
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-controls={hasSearchResults ? resultsId : undefined}
            aria-expanded={hasSearchResults}
            aria-activedescendant={activeResultId}
            aria-describedby={`planner-${target}-keyboard-help`}
            onKeyDown={(event) => handleSearchKeyDown(event, target)}
          />
          <button type="submit" disabled={busy !== null}>{busy === target ? "Searching…" : "Search"}</button>
        </form>
        <p id={`planner-${target}-keyboard-help`} className="screen-reader-only">
          After searching, use the up and down arrow keys to choose a result, Enter to select it, or Escape to close the matches.
        </p>
        {endpoint && <p className="planner-selected"><span aria-hidden="true" />{endpoint.label}</p>}
        <div className="planner-endpoint-actions">
          <button type="button" onClick={() => chooseMyLocation(target)} disabled={busy !== null}>Use my location</button>
          <button
            type="button"
            className={choosingOnMap ? "active" : ""}
            aria-pressed={choosingOnMap}
            onClick={() => onMapTargetChange(choosingOnMap ? null : target)}
          >
            {choosingOnMap ? "Cancel map choice" : "Choose on map"}
          </button>
        </div>
        {search?.target === target && search.results.length > 0 && (
          <div id={resultsId} className="planner-geocode-results" role="listbox" aria-label={`${label} address matches`}>
            {search.results.map((result, index) => (
              <button
                key={result.id}
                id={`${resultsId}-${index}`}
                type="button"
                role="option"
                aria-selected={search.activeResultIndex === index}
                tabIndex={-1}
                onMouseMove={() => setSearch((current) => current?.target === target
                  ? { ...current, activeResultIndex: index }
                  : current)}
                onClick={() => chooseResult(target, result)}
              >
                <strong>{result.label}</strong>
                <span>{result.type.replaceAll("_", " ")}</span>
              </button>
            ))}
            {search.attribution && <p>{search.attribution}</p>}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside className="route-planner" aria-label="Plan a bicycle route">
      <div className="planner-heading">
        <div><p className="eyebrow">Safety-aware routing</p><h2>Plan a bicycle route</h2></div>
        <button type="button" className="planner-swap" onClick={swapEndpoints} disabled={!endpoints.start && !endpoints.destination} aria-label="Swap start and destination">⇅ Swap</button>
      </div>

      {endpointEditor("start", "Start")}
      {endpointEditor("destination", "Destination")}

      <form className="planner-route-form" onSubmit={planRoute}>
        <fieldset>
          <legend>Minimum preferred safety</legend>
          <div className="planner-safety-options">
            {SAFETY_OPTIONS.map((option) => (
              <label key={option.value} className={safetyPreference === option.value ? "active" : ""}>
                <input
                  type="radio"
                  name="safety-preference"
                  value={option.value}
                  checked={safetyPreference === option.value}
                  onChange={() => {
                    invalidateRouteRequest();
                    setSafetyPreference(option.value);
                    onRouteChange(null);
                  }}
                />
                <span><strong>{option.label}</strong><small>{option.note}</small></span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="planner-fallback-note">This is a strong preference. Bicycle-legal streets may still be used when needed to reach an endpoint.</p>
        <button className="planner-submit" type="submit" disabled={busy !== null || !endpoints.start || !endpoints.destination}>
          {busy === "route" ? "Finding a route…" : "Plan route"}
        </button>
      </form>

      {message && <p className="planner-message" role="status" aria-live="polite">{message}</p>}

      {plannedRoute && (
        <section className="planner-summary" aria-label="Planned route summary" aria-live="polite">
          <div className="planner-summary-heading">
            <div><p className="eyebrow">Suggested route</p><h2>{formatMiles(plannedRoute.totalMiles)}</h2></div>
            <p>{plannedRoute.divergenceCount === 0 ? "Meets your preference" : `${formatMiles(plannedRoute.divergenceMiles)} below preference`}</p>
          </div>
          <dl className="planner-primary-metrics">
            <div><dt>Ascent</dt><dd>{formatFeet(plannedRoute.totalAscentFeet)}</dd></div>
            <div><dt>Descent</dt><dd>{formatFeet(plannedRoute.totalDescentFeet)}</dd></div>
            <div><dt>Lower-safety sections</dt><dd>{plannedRoute.divergenceCount}</dd></div>
          </dl>
          <div className="planner-safety-miles">
            <h3>Mileage by route type</h3>
            <dl>
              {SAFETY_CLASS_LABELS.map((label, safetyClass) => (
                <div key={label}><dt><span className={`safety-dot class-${safetyClass}`} />{label}</dt><dd>{formatMiles(plannedRoute.mileageBySafetyClass[safetyClass])}</dd></div>
              ))}
            </dl>
          </div>
          {plannedRoute.divergences.length > 0 && (
            <div className="planner-divergences">
              <h3>Lower-safety sections</h3>
              <ol>
                {plannedRoute.divergences.map((divergence, index) => (
                  <li key={`${divergence.reason}-${index}`}><strong>{formatMiles(divergence.miles)}</strong><span>{divergence.reason}</span></li>
                ))}
              </ol>
            </div>
          )}
          <button type="button" className="planner-guidance" onClick={startGuidance}>Start guidance</button>
        </section>
      )}
    </aside>
  );
}
