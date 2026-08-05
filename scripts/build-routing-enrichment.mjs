import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { buildRoutingEnrichment } from "./routing-enrichment.js";

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

const cityPath = required("--city");
const routingEdgesPath = required("--routing-edges");
const outputPath = required("--output");
const cityBuffer = await readFile(cityPath);
const routingEdgesBuffer = await readFile(routingEdgesPath);

const enrichment = buildRoutingEnrichment({
  cityCollection: JSON.parse(cityBuffer),
  routingEdgeCollection: JSON.parse(routingEdgesBuffer),
  toleranceMeters: Number(option("--tolerance-meters", 25)),
  sampleSpacingMeters: Number(option("--sample-spacing-meters", 20)),
  minimumCoverage: Number(option("--minimum-coverage", 0.8)),
  manifest: {
    cityDatasetVersion: required("--city-dataset-version"),
    cityDatasetSha256: sha256(cityBuffer),
    routingEdgesSha256: sha256(routingEdgesBuffer),
    osmExtractSource: required("--osm-extract-source"),
    osmExtractDate: required("--osm-extract-date"),
    osmExtractChecksum: required("--osm-extract-checksum"),
    routingGraphVersion: required("--routing-graph-version"),
    valhallaImage: required("--valhalla-image"),
  },
});

await writeFile(outputPath, `${JSON.stringify(enrichment, null, 2)}\n`);
console.log(JSON.stringify(enrichment.summary));
