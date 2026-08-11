import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { exportDirectedEdges } from "./valhalla-directed-edge-export.js";

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

const cityPath = required("--city");
const routingUrl = required("--routing-url");
const outputPath = required("--output");
const expectedGraphVersion = required("--routing-graph-version");
const cityCollection = JSON.parse(await readFile(cityPath));
const concurrency = Number(option("--concurrency", "4"));
const output = await exportDirectedEdges({ cityCollection, routingUrl, expectedGraphVersion, concurrency });
const temporaryOutputPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
await writeFile(temporaryOutputPath, `${JSON.stringify(output, null, 2)}\n`);
await rename(temporaryOutputPath, outputPath);
console.log(JSON.stringify({
  routingGraphVersion: output.routingGraphVersion,
  edges: output.features.length,
  ...output.traceSummary,
}));
