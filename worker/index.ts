/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { createAuthHandler } from "./auth";
import { createBikeFacilitiesHandler } from "./bike-facilities";
import { createRideHandler } from "./rides";
import { createGeocodeHandler } from "./geocode";
import {
  createFullHealthHandler,
  createGeocodingHealthHandler,
  createHealthHandler,
  createRoutingEnrichmentHealthHandler,
} from "./health";
import { createOpenApiHandler } from "./openapi";
import { createSqliteRoutingEnrichmentStore, routingEnrichmentEnabled } from "./routing-enrichment";
import { createRoutesHandler, createRoutingHealthHandler } from "./routes";

interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface RouteMetric {
  event: string;
  outcome: string;
  status: number;
  durationMs: number;
  safetyPreference?: string;
}

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  GEOCODER_URL?: string;
  GEOCODER_ACCESS_CLIENT_ID?: string;
  GEOCODER_ACCESS_CLIENT_SECRET?: string;
  ROUTING_URL?: string;
  ROUTING_ACCESS_CLIENT_ID?: string;
  ROUTING_ACCESS_CLIENT_SECRET?: string;
  ROUTING_ENRICHMENT_URL?: string;
  ROUTING_ENRICHMENT_ACCESS_CLIENT_ID?: string;
  ROUTING_ENRICHMENT_ACCESS_CLIENT_SECRET?: string;
  ROUTING_ENRICHMENT_ENABLED?: string;
  GEOCODE_RATE_LIMITER?: RateLimitBinding;
  ROUTE_RATE_LIMITER?: RateLimitBinding;
  JWT_SECRET?: string;
  PASSWORD_PEPPER?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return createHealthHandler({ database: env.DB })(request);
    }

    if (url.pathname === "/api/health/full") {
      return createFullHealthHandler({
        database: env.DB,
        routing: {
          providerUrl: env.ROUTING_URL,
          accessClientId: env.ROUTING_ACCESS_CLIENT_ID,
          accessClientSecret: env.ROUTING_ACCESS_CLIENT_SECRET,
        },
        geocoding: {
          providerUrl: env.GEOCODER_URL,
          accessClientId: env.GEOCODER_ACCESS_CLIENT_ID,
          accessClientSecret: env.GEOCODER_ACCESS_CLIENT_SECRET,
        },
        routingEnrichment: {
          enabled: routingEnrichmentEnabled(env.ROUTING_ENRICHMENT_ENABLED),
          sidecarUrl: env.ROUTING_ENRICHMENT_URL,
          accessClientId: env.ROUTING_ENRICHMENT_ACCESS_CLIENT_ID,
          accessClientSecret: env.ROUTING_ENRICHMENT_ACCESS_CLIENT_SECRET,
        },
      })(request);
    }

    if (url.pathname === "/api/geocoding-health") {
      return createGeocodingHealthHandler({
        providerUrl: env.GEOCODER_URL,
        accessClientId: env.GEOCODER_ACCESS_CLIENT_ID,
        accessClientSecret: env.GEOCODER_ACCESS_CLIENT_SECRET,
      })(request);
    }

    if (url.pathname === "/api/routing-enrichment-health") {
      return createRoutingEnrichmentHealthHandler({
        enabled: routingEnrichmentEnabled(env.ROUTING_ENRICHMENT_ENABLED),
        sidecarUrl: env.ROUTING_ENRICHMENT_URL,
        accessClientId: env.ROUTING_ENRICHMENT_ACCESS_CLIENT_ID,
        accessClientSecret: env.ROUTING_ENRICHMENT_ACCESS_CLIENT_SECRET,
      })(request);
    }

    if (url.pathname === "/api/openapi.json") {
      return createOpenApiHandler()(request);
    }

    if (url.pathname === "/api/bike-facilities") {
      const cache = typeof caches === "undefined"
        ? undefined
        : (caches as CacheStorage & { default: Cache }).default;
      return createBikeFacilitiesHandler({ cache })(request);
    }

    if (url.pathname === "/api/geocode") {
      const cache = typeof caches === "undefined"
        ? undefined
        : (caches as CacheStorage & { default: Cache }).default;
      return createGeocodeHandler({
        providerUrl: env.GEOCODER_URL,
        accessClientId: env.GEOCODER_ACCESS_CLIENT_ID,
        accessClientSecret: env.GEOCODER_ACCESS_CLIENT_SECRET,
        cache,
        rateLimiter: env.GEOCODE_RATE_LIMITER,
      })(request);
    }

    if (url.pathname === "/api/routes") {
      return createRoutesHandler({
        providerUrl: env.ROUTING_URL,
        accessClientId: env.ROUTING_ACCESS_CLIENT_ID,
        accessClientSecret: env.ROUTING_ACCESS_CLIENT_SECRET,
        rateLimiter: env.ROUTE_RATE_LIMITER,
        reportMetric: (metric: RouteMetric) => console.log(metric),
        enrichmentStore: routingEnrichmentEnabled(env.ROUTING_ENRICHMENT_ENABLED)
          ? createSqliteRoutingEnrichmentStore({
            sidecarUrl: env.ROUTING_ENRICHMENT_URL,
            accessClientId: env.ROUTING_ENRICHMENT_ACCESS_CLIENT_ID,
            accessClientSecret: env.ROUTING_ENRICHMENT_ACCESS_CLIENT_SECRET,
          })
          : undefined,
      })(request);
    }

    if (url.pathname === "/api/routing-health") {
      return createRoutingHealthHandler({
        providerUrl: env.ROUTING_URL,
        accessClientId: env.ROUTING_ACCESS_CLIENT_ID,
        accessClientSecret: env.ROUTING_ACCESS_CLIENT_SECRET,
      })(request);
    }

    if (url.pathname.startsWith("/api/auth/")) {
      return createAuthHandler({
        db: env.DB,
        jwtSecret: env.JWT_SECRET,
        passwordPepper: env.PASSWORD_PEPPER,
      })(request);
    }

    if (url.pathname === "/api/rides" || url.pathname.startsWith("/api/rides/")) {
      return createRideHandler({
        db: env.DB,
        jwtSecret: env.JWT_SECRET,
      })(request);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
