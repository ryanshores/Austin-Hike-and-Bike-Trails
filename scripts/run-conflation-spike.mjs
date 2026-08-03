import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { fetchAllBikeFacilities } from "../worker/bike-facilities.js";
import { providerEndpoint } from "../worker/api-utils.js";
import { decodePolyline6 } from "../worker/routes.js";
import { boundsForLine, evaluateConflation } from "./conflation-evaluator.js";

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

function markdownReport(report) {
  const rows = report.results.map((result) => `| ${result.id} | ${result.category} | ${result.coverageRatio.toFixed(1)} | ${result.matchedMiles.toFixed(2)} | ${result.ambiguousMiles.toFixed(2)} | ${result.unmatchedMiles.toFixed(2)} |`).join("\n");
  return `# City/OSM conflation spike results\n\nGenerated: ${report.generatedAt}\n\n- City dataset: ${report.cityDataset}\n- Routing graph: ${report.routingGraph}\n- Tolerance: ${report.toleranceMeters} m\n- Sample spacing: ${report.sampleSpacingMeters} m\n\n| Connection | Category | City coverage | Matched mi | Ambiguous mi | Unmatched mi |\n| --- | --- | ---: | ---: | ---: | ---: |\n${rows}\n\nA zero or low coverage result is evidence to investigate, not a reason to promote a route section to a safe class.\n`;
}

const routingUrl = option("--routing-url");
if (!routingUrl) throw new Error("Usage: node scripts/run-conflation-spike.mjs --routing-url https://valhalla.example [--output /tmp/conflation-results]");
const cases = JSON.parse(await readFile(resolve(option("--cases", "data/conflation-cases.json")), "utf8"));
const outputPrefix = resolve(option("--output", "/tmp/austin-conflation-results"));
const toleranceMeters = Number(option("--tolerance-meters", "25"));
const sampleSpacingMeters = Number(option("--sample-spacing-meters", "20"));
const statusResponse = await fetch(providerEndpoint(routingUrl, "/status"));
if (!statusResponse.ok) throw new Error(`Valhalla status returned HTTP ${statusResponse.status}.`);
const status = await statusResponse.json();
const results = [];

for (const connection of cases) {
  const response = await fetch(providerEndpoint(routingUrl, "/route"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ locations: [{ lat: connection.start.latitude, lon: connection.start.longitude, type: "break" }, { lat: connection.destination.latitude, lon: connection.destination.longitude, type: "break" }], costing: "bicycle", units: "miles", shape_format: "polyline6" }),
  });
  if (!response.ok) throw new Error(`${connection.id}: Valhalla route returned HTTP ${response.status}.`);
  const route = routeGeometry((await response.json()).trip);
  const facilities = await fetchAllBikeFacilities(boundsForLine(route), fetch);
  results.push({ id: connection.id, name: connection.name, category: connection.category, ...evaluateConflation({ route, cityFeatures: facilities.features, toleranceMeters, sampleSpacingMeters }) });
}

const report = { generatedAt: new Date().toISOString(), cityDataset: "austin-bike-facilities-v1", routingGraph: String(status.osm_changeset ?? status.tileset_last_modified ?? "unknown"), toleranceMeters, sampleSpacingMeters, results };
await writeFile(`${outputPrefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(`${outputPrefix}.md`, markdownReport(report));
console.log(`Wrote ${outputPrefix}.json and ${outputPrefix}.md`);
