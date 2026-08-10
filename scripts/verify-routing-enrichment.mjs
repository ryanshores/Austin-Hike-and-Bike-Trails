import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { verifyRoutingEnrichment } from "./routing-enrichment.js";

const args = process.argv.slice(2);
function option(name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`Missing required option ${name}.`);
  return value;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function expectedManifest() {
  const flags = {
    cityDatasetVersion: "--expected-city-dataset-version",
    osmExtractSource: "--expected-osm-extract-source",
    osmExtractDate: "--expected-osm-extract-date",
    osmExtractChecksum: "--expected-osm-extract-checksum",
    routingGraphVersion: "--expected-routing-graph-version",
    valhallaImage: "--expected-valhalla-image",
  };
  return Object.fromEntries(Object.entries(flags).flatMap(([field, flag]) => {
    const value = option(flag);
    if (value === null) return [];
    if (!value) throw new Error(`Missing value for optional manifest pin ${flag}.`);
    return [[field, value]];
  }));
}

const enrichmentPath = required("--enrichment");
const cityPath = required("--city");
const routingEdgesPath = required("--routing-edges");
const [enrichmentBuffer, cityBuffer, routingEdgesBuffer] = await Promise.all([
  readFile(enrichmentPath),
  readFile(cityPath),
  readFile(routingEdgesPath),
]);

const verified = verifyRoutingEnrichment({
  enrichment: JSON.parse(enrichmentBuffer),
  cityCollection: JSON.parse(cityBuffer),
  routingEdgeCollection: JSON.parse(routingEdgesBuffer),
  cityDatasetSha256: sha256(cityBuffer),
  routingEdgesSha256: sha256(routingEdgesBuffer),
  expectedManifest: expectedManifest(),
});

console.log(JSON.stringify({ verified: true, summary: verified.summary }));
