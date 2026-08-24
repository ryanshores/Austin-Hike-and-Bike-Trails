import { providerEndpoint, requestAllowed, sharedGeocoderRateLimitKey } from "./api-utils.js";

export const EXPECTED_D1_MIGRATION = "0004_private_ride_heatmap.sql";
export const HEALTH_CHECK_TIMEOUT_MS = 3_000;

function healthResponse(value, status) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function methodNotAllowed(request) {
  return request.method === "GET"
    ? null
    : healthResponse({ status: "unavailable", error: "Method not allowed." }, 405);
}

function accessHeaders(accessClientId, accessClientSecret) {
  if (!accessClientId && !accessClientSecret) return {};
  if (!accessClientId || !accessClientSecret) return null;
  return {
    "CF-Access-Client-Id": accessClientId,
    "CF-Access-Client-Secret": accessClientSecret,
  };
}

function serviceResult(service, status, extra = {}) {
  return { status, service, ...extra };
}

export async function boundedHealthFetch(
  fetchImpl,
  request,
  url,
  headers,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const abortForRequest = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) abortForRequest();
  else request.signal.addEventListener("abort", abortForRequest, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortForRequest);
  };
  try {
    const response = await fetchImpl(url, {
      redirect: "manual",
      headers,
      signal: controller.signal,
    });
    return { response, release };
  } catch (error) {
    release();
    throw error;
  }
}

async function checkProvider({
  service,
  providerUrl,
  accessClientId,
  accessClientSecret,
  pathname,
  request,
  fetchImpl,
  timeoutMs,
  headers = {},
}) {
  if (!providerUrl) return serviceResult(service, "unconfigured");
  const providerAccessHeaders = accessHeaders(accessClientId, accessClientSecret);
  if (!providerAccessHeaders) return serviceResult(service, "unconfigured");
  try {
    const { response, release } = await boundedHealthFetch(
      fetchImpl,
      request,
      providerEndpoint(providerUrl, pathname),
      { Accept: "application/json", ...headers, ...providerAccessHeaders },
      timeoutMs,
    );
    if (!response.ok) {
      release();
      return serviceResult(service, "unavailable");
    }
    return { response, release, result: serviceResult(service, "ok") };
  } catch (error) {
    if (request.signal.aborted) throw error;
    return serviceResult(service, "unavailable");
  }
}

export async function checkInternalHealth({ database } = {}) {
  const checks = {
    worker: { status: "ok" },
    database: { status: "unavailable" },
    migrations: { status: "unavailable", expected: EXPECTED_D1_MIGRATION },
  };
  if (!database?.prepare) return { status: "unavailable", checks };

  try {
    await database.prepare("SELECT 1 AS health").first();
    checks.database = { status: "ok" };
  } catch {
    return { status: "unavailable", checks };
  }

  try {
    const migration = await database
      .prepare("SELECT name FROM d1_migrations WHERE name = ? LIMIT 1")
      .bind(EXPECTED_D1_MIGRATION)
      .first();
    checks.migrations = migration?.name === EXPECTED_D1_MIGRATION
      ? { status: "ok", expected: EXPECTED_D1_MIGRATION }
      : { status: "outdated", expected: EXPECTED_D1_MIGRATION };
  } catch {
    checks.migrations = { status: "unavailable", expected: EXPECTED_D1_MIGRATION };
  }
  return {
    status: checks.migrations.status === "ok" ? "ok" : "unavailable",
    checks,
  };
}

export async function checkRoutingHealth({
  providerUrl,
  accessClientId,
  accessClientSecret,
  request,
  fetchImpl = fetch,
  timeoutMs,
} = {}) {
  const checked = await checkProvider({
    service: "routing",
    providerUrl,
    accessClientId,
    accessClientSecret,
    pathname: "/status",
    request,
    fetchImpl,
    timeoutMs,
  });
  if (!checked.response) return checked;
  try {
    const status = await checked.response.json();
    return serviceResult("routing", status.has_tiles === false ? "degraded" : "ok", {
      provider: "valhalla",
      version: String(status.version ?? "unknown"),
      routingGraphVersion: String(status.osm_changeset ?? status.tileset_last_modified ?? "unknown"),
    });
  } catch {
    return serviceResult("routing", "unavailable");
  } finally {
    checked.release();
  }
}

export async function checkGeocodingHealth({
  providerUrl,
  accessClientId,
  accessClientSecret,
  request,
  fetchImpl = fetch,
  timeoutMs,
} = {}) {
  const checked = await checkProvider({
    service: "geocoding",
    providerUrl,
    accessClientId,
    accessClientSecret,
    pathname: "/status",
    request,
    fetchImpl,
    timeoutMs,
    headers: {
      "User-Agent": "Austin-Hike-Bike-Atlas/1.0 (+https://github.com/ryanshores/Austin-Hike-and-Bike-Trails)",
    },
  });
  if (!checked.response) return checked;
  checked.release();
  return checked.result;
}

export async function checkRoutingEnrichmentHealth({
  enabled,
  sidecarUrl,
  accessClientId,
  accessClientSecret,
  request,
  fetchImpl = fetch,
  timeoutMs,
} = {}) {
  if (!enabled) return serviceResult("routing-enrichment", "disabled");
  const checked = await checkProvider({
    service: "routing-enrichment",
    providerUrl: sidecarUrl,
    accessClientId,
    accessClientSecret,
    pathname: "/health",
    request,
    fetchImpl,
    timeoutMs,
  });
  if (!checked.response) return checked;
  try {
    const status = await checked.response.json();
    return serviceResult("routing-enrichment", status?.status === "ready" ? "ok" : "unavailable");
  } catch {
    return serviceResult("routing-enrichment", "unavailable");
  } finally {
    checked.release();
  }
}

function remoteResponseStatus(result) {
  if (result.status === "ok" || result.status === "degraded") return 200;
  return result.status === "unconfigured" || result.status === "disabled" ? 503 : 502;
}

export function createHealthHandler(options = {}) {
  return async function handleHealth(request) {
    const methodError = methodNotAllowed(request);
    if (methodError) return methodError;
    const result = await checkInternalHealth(options);
    return healthResponse(result, result.status === "ok" ? 200 : 503);
  };
}

export function createGeocodingHealthHandler(options = {}) {
  return async function handleGeocodingHealth(request) {
    const methodError = methodNotAllowed(request);
    if (methodError) return methodError;
    const result = await checkGeocodingHealth({ ...options, request });
    return healthResponse(result, remoteResponseStatus(result));
  };
}

export function createRoutingEnrichmentHealthHandler(options = {}) {
  return async function handleRoutingEnrichmentHealth(request) {
    const methodError = methodNotAllowed(request);
    if (methodError) return methodError;
    const result = await checkRoutingEnrichmentHealth({ ...options, request });
    return healthResponse(result, remoteResponseStatus(result));
  };
}

export function createFullHealthHandler(options = {}) {
  return async function handleFullHealth(request) {
    const methodError = methodNotAllowed(request);
    if (methodError) return methodError;
    if (!(await requestAllowed(options.rateLimiter, request))) {
      return healthResponse({
        status: "rate-limited",
        error: "Too many full health checks. Try again shortly.",
      }, 429);
    }
    if (!(await requestAllowed(
      options.geocodeRateLimiter,
      request,
      sharedGeocoderRateLimitKey(options.geocoding?.providerUrl),
    ))) {
      return healthResponse({
        status: "rate-limited",
        error: "Too many full health checks. Try again shortly.",
      }, 429);
    }
    const [internal, routing, geocoding, routingEnrichment] = await Promise.all([
      checkInternalHealth(options),
      checkRoutingHealth({
        ...options.routing,
        request,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      }),
      checkGeocodingHealth({
        ...options.geocoding,
        request,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      }),
      checkRoutingEnrichmentHealth({
        ...options.routingEnrichment,
        request,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      }),
    ]);
    const checks = {
      ...internal.checks,
      routing,
      geocoding,
      routingEnrichment,
    };
    const remoteResults = [routing, geocoding, routingEnrichment];
    const unavailableConfiguredService = remoteResults.some((result) => result.status === "unavailable");
    const allHealthy = internal.status === "ok" && remoteResults.every((result) => result.status === "ok");
    const status = internal.status !== "ok" || unavailableConfiguredService
      ? "unavailable"
      : allHealthy ? "ok" : "degraded";
    return healthResponse({ status, checks }, status === "unavailable" ? 503 : 200);
  };
}
