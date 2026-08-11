import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const loaderPath = new URL("../scripts/build-routing-enrichment-sqlite.py", import.meta.url);
const serverPath = new URL("../infra/valhalla/routing_enrichment_server.py", import.meta.url);

function artifact(overrides = {}) {
  return {
    schemaVersion: 1,
    manifest: {
      cityDatasetVersion: "city-v1",
      cityDatasetSha256: "city-sha",
      routingEdgesSha256: "edges-sha",
      osmExtractSource: "austin.osm.pbf",
      osmExtractDate: "2026-08-11",
      osmExtractChecksum: "md5:source-checksum",
      routingGraphVersion: "1786234669",
      valhallaImage: "valhalla@sha256:test",
      toleranceMeters: 25,
      sampleSpacingMeters: 20,
      minimumCoverage: 0.8,
    },
    summary: { edges: 2 },
    edges: [
      {
        edgeId: "edge-fully-separated",
        travelDirection: "forward",
        cityMatch: {
          status: "matched",
          coverageRatio: 1,
          matchedMiles: 0.25,
          ambiguousMiles: 0,
          unmatchedMiles: 0,
        },
        city: { BICYCLE_FACILITY: "Urban Trail" },
        osm: { highway: "cycleway" },
        classification: {
          safetyClass: 3,
          finding: "atlas",
          source: "city",
          reason: "fully separated path",
        },
      },
      {
        edgeId: "edge-prohibited",
        travelDirection: null,
        cityMatch: {
          status: "unmatched",
          coverageRatio: 0,
          matchedMiles: 0,
          ambiguousMiles: 0,
          unmatchedMiles: 0.1,
        },
        city: null,
        osm: { highway: "footway", bicycle: "no" },
        classification: {
          safetyClass: null,
          finding: "bicycle-prohibited",
          source: "osm",
          reason: "bicycles are not explicitly permitted",
        },
      },
    ],
    ...overrides,
  };
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForReady(url) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError;
}

test("SQLite loader atomically validates and serves exact graph-versioned records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-enrichment-"));
  const artifactPath = join(directory, "artifact.json");
  const databasePath = join(directory, "routing-enrichment.sqlite");
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let server;
  try {
    await writeFile(artifactPath, `${JSON.stringify(artifact())}\n`);
    await execFile("python3", [loaderPath.pathname, "--artifact", artifactPath, "--output", databasePath]);

    server = spawn("python3", [
      serverPath.pathname,
      "--database",
      databasePath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ], { stdio: "ignore" });
    await waitForReady(origin);

    const lookup = await fetch(`${origin}/v1/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routingGraphVersion: "1786234669",
        edgeIds: ["edge-fully-separated", "missing", "edge-fully-separated"],
      }),
    });
    assert.equal(lookup.status, 200);
    assert.deepEqual(await lookup.json(), {
      routingGraphVersion: "1786234669",
      records: [{
        edgeId: "edge-fully-separated",
        travelDirection: "forward",
        cityMatch: {
          status: "matched",
          coverageRatio: 1,
          matchedMiles: 0.25,
          ambiguousMiles: 0,
          unmatchedMiles: 0,
        },
        city: { BICYCLE_FACILITY: "Urban Trail" },
        osm: { highway: "cycleway" },
        classification: {
          safetyClass: 3,
          finding: "atlas",
          source: "city",
          reason: "fully separated path",
        },
      }],
    });

    const wrongGraph = await fetch(`${origin}/v1/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routingGraphVersion: "other-graph", edgeIds: ["edge-fully-separated"] }),
    });
    assert.deepEqual(await wrongGraph.json(), { routingGraphVersion: "other-graph", records: [] });

    const invalidRequest = await fetch(`${origin}/v1/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routingGraphVersion: "1786234669", edgeIds: [""] }),
    });
    assert.equal(invalidRequest.status, 400);

    const originalDatabase = await readFile(databasePath);
    await writeFile(artifactPath, `${JSON.stringify(artifact({
      manifest: { ...artifact().manifest, minimumCoverage: 0.01 },
    }))}\n`);
    await assert.rejects(
      execFile("python3", [loaderPath.pathname, "--artifact", artifactPath, "--output", databasePath]),
      /minimumCoverage must equal 0.8/,
    );
    assert.deepEqual(await readFile(databasePath), originalDatabase);
  } finally {
    server?.kill();
    await rm(directory, { force: true, recursive: true });
  }
});
