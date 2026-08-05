import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { BIKE_CACHE_DATASET_VERSION, fetchAllBikeFacilities } from "../worker/bike-facilities.js";
import { providerEndpoint } from "../worker/api-utils.js";
import { decodePolyline6 } from "../worker/routes.js";
import { boundsForLine, evaluateConflation } from "./conflation-evaluator.js";
import { elevationSummary, markdownReport, reportSummary } from "./conflation-report.js";

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

function routeGeometry(route) {
  if (!Array.isArray(route?.legs) || route.legs.length === 0) throw new Error("Valhalla returned no route legs.");
  const coordinates = [];
  for (const leg of route.legs) for (const coordinate of decodePolyline6(String(leg.shape ?? ""))) {
    const previous = coordinates.at(-1);
    if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) coordinates.push(coordinate);
  }
  return { type: "LineString", coordinates };
}

const routingUrl = option("--routing-url");
if (!routingUrl) throw new Error("Usage: node scripts/run-conflation-spike.mjs --routing-url https://valhalla.example [--output /tmp/conflation-results]");
const cases = JSON.parse(await readFile(resolve(option("--cases", "data/conflation-cases.json")), "utf8"));
const outputPrefix = resolve(option("--output", "/tmp/austin-conflation-results"));
const toleranceMeters = Number(option("--tolerance-meters", "25"));
const sampleSpacingMeters = Number(option("--sample-spacing-meters", "20"));
const statusResponse = await fetch(providerEndpoint(routingUrl, "/status?verbose=true"));
if (!statusResponse.ok) throw new Error(`Valhalla status returned HTTP ${statusResponse.status}.`);
const status = await statusResponse.json();
const results = [];

for (const connection of cases) {
  try {
    const response = await fetch(providerEndpoint(routingUrl, "/route"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ locations: [{ lat: connection.start.latitude, lon: connection.start.longitude, type: "break" }, { lat: connection.destination.latitude, lon: connection.destination.longitude, type: "break" }], costing: "bicycle", units: "miles", shape_format: "polyline6" }),
    });
    if (!response.ok) throw new Error(`Valhalla route returned HTTP ${response.status}.`);
    const route = routeGeometry((await response.json()).trip);
    const [facilities, elevationResponse] = await Promise.all([
      fetchAllBikeFacilities(boundsForLine(route), fetch),
      fetch(providerEndpoint(routingUrl, "/height"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ shape: route.coordinates.map(([lon, lat]) => ({ lat, lon })), range: true, resample_distance: 30, height_precision: 1 }),
      }),
    ]);
    if (!elevationResponse.ok) throw new Error(`Valhalla height returned HTTP ${elevationResponse.status}.`);
    results.push({ id: connection.id, name: connection.name, category: connection.category, status: "ok", elevation: elevationSummary(await elevationResponse.json()), ...evaluateConflation({ route, cityFeatures: facilities.features, toleranceMeters, sampleSpacingMeters }) });
  } catch (error) {
    results.push({ id: connection.id, name: connection.name, category: connection.category, status: "failed", error: error instanceof Error ? error.message : String(error) });
  }
}

const summary = reportSummary(results);
const report = {
  generatedAt: new Date().toISOString(),
  cityDataset: BIKE_CACHE_DATASET_VERSION,
  routingGraph: String(status.osm_changeset ?? status.tileset_last_modified ?? "unknown"),
  valhallaVersion: String(status.version ?? "unknown"),
  valhallaImage: option("--valhalla-image", "unknown"),
  osmExtract: { source: option("--osm-extract-source", "unknown"), date: option("--osm-extract-date", "unknown"), md5: option("--osm-extract-md5", "unknown") },
  toleranceMeters,
  sampleSpacingMeters,
  summary,
  results,
};
await writeFile(`${outputPrefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(`${outputPrefix}.md`, markdownReport(report));
console.log(`Wrote ${outputPrefix}.json and ${outputPrefix}.md`);
if (summary.failed > 0) process.exitCode = 1;
