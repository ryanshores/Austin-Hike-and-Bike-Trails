/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { createAuthHandler } from "./auth";
import { createBikeFacilitiesHandler } from "./bike-facilities";
import { createRideHandler } from "./rides";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
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

    if (url.pathname === "/api/bike-facilities") {
      const cache = typeof caches === "undefined"
        ? undefined
        : (caches as CacheStorage & { default: Cache }).default;
      return createBikeFacilitiesHandler({ cache })(request);
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
