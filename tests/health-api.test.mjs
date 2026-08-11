import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  EXPECTED_D1_MIGRATION,
  checkRoutingHealth,
  createFullHealthHandler,
  createGeocodingHealthHandler,
  createHealthHandler,
  createRoutingEnrichmentHealthHandler,
} from "../worker/health.js";
import { OPENAPI_DOCUMENT, createOpenApiHandler } from "../worker/openapi.js";

function database({ migrated = true, databaseError = null, migrationError = null } = {}) {
  return {
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (sql.startsWith("SELECT 1")) {
            if (databaseError) throw databaseError;
            return { health: 1 };
          }
          if (migrationError) throw migrationError;
          return migrated ? { name: EXPECTED_D1_MIGRATION } : null;
        },
      };
    },
  };
}

function request(path = "/api/health", options) {
  return new Request(`https://atlas.example${path}`, options);
}

test("health metadata tracks the latest checked-in D1 migration", () => {
  const migrationsDirectory = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const latestMigration = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .at(-1);
  assert.equal(EXPECTED_D1_MIGRATION, latestMigration);
});

test("internal health checks D1 connectivity and expected migration without using fetch", async () => {
  const response = await createHealthHandler({ database: database() })(request());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    status: "ok",
    checks: {
      worker: { status: "ok" },
      database: { status: "ok" },
      migrations: { status: "ok", expected: EXPECTED_D1_MIGRATION },
    },
  });
});

test("internal health fails safely for unavailable D1 and migration status", async () => {
  const unreachable = await createHealthHandler({
    database: database({ databaseError: new Error("private D1 failure") }),
  })(request());
  assert.equal(unreachable.status, 503);
  assert.equal(JSON.stringify(await unreachable.json()).includes("private D1 failure"), false);

  const outdated = await createHealthHandler({ database: database({ migrated: false }) })(request());
  assert.equal(outdated.status, 503);
  assert.equal((await outdated.json()).checks.migrations.status, "outdated");

  const missingLedger = await createHealthHandler({
    database: database({ migrationError: new Error("no such table: d1_migrations") }),
  })(request());
  assert.equal(missingLedger.status, 503);
  assert.equal((await missingLedger.json()).checks.migrations.status, "unavailable");
});

test("health endpoints only allow GET", async () => {
  const response = await createHealthHandler({ database: database() })(
    request("/api/health", { method: "POST" }),
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("geocoding health probes only the configured status URL with optional Access credentials", async () => {
  let call;
  const response = await createGeocodingHealthHandler({
    providerUrl: "https://geocoding.internal/base/",
    accessClientId: "geocoder-client",
    accessClientSecret: "geocoder-secret",
    fetchImpl: async (url, options) => {
      call = { url: new URL(url), options };
      return Response.json({ status: "ok" });
    },
  })(request("/api/geocoding-health"));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", service: "geocoding" });
  assert.equal(call.url.pathname, "/base/status");
  assert.equal(call.options.redirect, "manual");
  assert.equal(call.options.headers["CF-Access-Client-Id"], "geocoder-client");
  assert.equal(call.options.headers["CF-Access-Client-Secret"], "geocoder-secret");
  assert.match(call.options.headers["User-Agent"], /Austin-Hike-Bike-Atlas/);

  const incompleteCredentials = await createGeocodingHealthHandler({
    providerUrl: "https://geocoding.internal",
    accessClientId: "geocoder-client",
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
  })(request("/api/geocoding-health"));
  assert.equal(incompleteCredentials.status, 503);
  assert.deepEqual(await incompleteCredentials.json(), {
    status: "unconfigured",
    service: "geocoding",
  });
});

test("routing enrichment health distinguishes disabled, unavailable, and ready sidecars", async () => {
  const disabled = await createRoutingEnrichmentHealthHandler({ enabled: false })(
    request("/api/routing-enrichment-health"),
  );
  assert.equal(disabled.status, 503);
  assert.deepEqual(await disabled.json(), {
    status: "disabled",
    service: "routing-enrichment",
  });

  const unavailable = await createRoutingEnrichmentHealthHandler({
    enabled: true,
    sidecarUrl: "https://enrichment.internal",
    accessClientId: "enrichment-client",
    accessClientSecret: "enrichment-secret",
    fetchImpl: async () => new Response("nope", { status: 503 }),
  })(request("/api/routing-enrichment-health"));
  assert.equal(unavailable.status, 502);
  assert.deepEqual(await unavailable.json(), {
    status: "unavailable",
    service: "routing-enrichment",
  });

  const ready = await createRoutingEnrichmentHealthHandler({
    enabled: true,
    sidecarUrl: "https://enrichment.internal",
    accessClientId: "enrichment-client",
    accessClientSecret: "enrichment-secret",
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).pathname, "/health");
      assert.equal(options.headers["CF-Access-Client-Secret"], "enrichment-secret");
      return Response.json({ status: "ready" });
    },
  })(request("/api/routing-enrichment-health"));
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ok", service: "routing-enrichment" });
});

test("full health concurrently aggregates local and configured remote checks", async () => {
  const paths = [];
  const handle = createFullHealthHandler({
    database: database(),
    routing: { providerUrl: "https://routing.internal" },
    geocoding: { providerUrl: "https://geocoding.internal" },
    routingEnrichment: {
      enabled: true,
      sidecarUrl: "https://enrichment.internal",
    },
    fetchImpl: async (url) => {
      const endpoint = new URL(url);
      paths.push(`${endpoint.hostname}${endpoint.pathname}`);
      if (endpoint.hostname === "routing.internal") {
        return Response.json({ version: "3.7.0", has_tiles: true, tileset_last_modified: 123 });
      }
      if (endpoint.hostname === "enrichment.internal") return Response.json({ status: "ready" });
      return Response.json({ status: "ok" });
    },
  });
  const response = await handle(request("/api/health/full"));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(body.checks.database.status, "ok");
  assert.equal(body.checks.routing.status, "ok");
  assert.equal(body.checks.geocoding.status, "ok");
  assert.equal(body.checks.routingEnrichment.status, "ok");
  assert.deepEqual(paths.sort(), [
    "enrichment.internal/health",
    "geocoding.internal/status",
    "routing.internal/status",
  ]);
});

test("full health exposes remote failures and disabled enrichment without sensitive details", async () => {
  const handle = createFullHealthHandler({
    database: database(),
    routing: { providerUrl: "https://routing.internal" },
    geocoding: { providerUrl: "https://geocoding.internal" },
    routingEnrichment: { enabled: false },
    fetchImpl: async (url) => {
      if (new URL(url).hostname === "routing.internal") return new Response("private upstream error", { status: 503 });
      return Response.json({ status: "ok" });
    },
  });
  const response = await handle(request("/api/health/full"));

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, "unavailable");
  assert.equal(body.checks.routing.status, "unavailable");
  assert.equal(body.checks.routingEnrichment.status, "disabled");
  assert.equal(JSON.stringify(body).includes("private upstream error"), false);
});

test("full health is limited before it queries D1 or remote services", async () => {
  let fetches = 0;
  const response = await createFullHealthHandler({
    database: database(),
    rateLimiter: { async limit() { return { success: false }; } },
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("must not fetch");
    },
  })(request("/api/health/full"));

  assert.equal(response.status, 429);
  assert.equal(fetches, 0);
  assert.deepEqual(await response.json(), {
    status: "rate-limited",
    error: "Too many full health checks. Try again shortly.",
  });
});

test("full health uses the application-wide geocoder limiter key for public Nominatim", async () => {
  const geocoderKeys = [];
  const response = await createFullHealthHandler({
    database: database(),
    rateLimiter: { async limit() { return { success: true }; } },
    geocodeRateLimiter: {
      async limit({ key }) {
        geocoderKeys.push(key);
        return { success: false };
      },
    },
    geocoding: { providerUrl: "https://nominatim.openstreetmap.org" },
  })(request("/api/health/full"));

  assert.equal(response.status, 429);
  assert.deepEqual(geocoderKeys, ["public-nominatim-application"]);
});

test("remote health timeout remains active until a response body is consumed", async () => {
  let providerSignal;
  const result = await checkRoutingHealth({
    providerUrl: "https://routing.internal",
    request: request("/api/health/full"),
    timeoutMs: 5,
    fetchImpl: async (_url, options) => {
      providerSignal = options.signal;
      return {
        ok: true,
        json() {
          return new Promise((_resolve, reject) => {
            providerSignal.addEventListener("abort", () => reject(new Error("body timed out")));
          });
        },
      };
    },
  });

  assert.equal(providerSignal.aborted, true);
  assert.deepEqual(result, { status: "unavailable", service: "routing" });
});

test("OpenAPI describes every health endpoint and is non-cacheable", async () => {
  const response = await createOpenApiHandler()(request("/api/openapi.json"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), OPENAPI_DOCUMENT);
  for (const path of [
    "/api/health",
    "/api/health/full",
    "/api/routing-health",
    "/api/geocoding-health",
    "/api/routing-enrichment-health",
  ]) {
    assert.ok(OPENAPI_DOCUMENT.paths[path]);
  }
  assert.equal(
    OPENAPI_DOCUMENT.paths["/api/routing-health"].get.responses[502].content["application/json"].schema.$ref,
    "#/components/schemas/HealthFailure",
  );
  assert.equal((await createOpenApiHandler()(request("/api/openapi.json", { method: "POST" }))).status, 405);
});
