import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

import { fetchAllBikeFacilities, parseBounds } from "../worker/bike-facilities.js";

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`Missing required option ${name}.`);
  return value;
}

const bounds = parseBounds(required("--bounds"));
const outputPath = required("--output");
const collection = await fetchAllBikeFacilities(bounds, fetch);
const temporaryOutputPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
await writeFile(temporaryOutputPath, `${JSON.stringify(collection, null, 2)}\n`);
await rename(temporaryOutputPath, outputPath);
console.log(JSON.stringify({ features: collection.features.length }));
