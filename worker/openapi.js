const healthCheck = {
  get: {
    summary: "Health check",
    responses: {
      200: {
        description: "Healthy or degraded diagnostic response",
        content: { "application/json": { schema: { $ref: "#/components/schemas/HealthResponse" } } },
      },
      405: {
        description: "Only GET is supported",
        content: { "application/json": { schema: { $ref: "#/components/schemas/HealthFailure" } } },
      },
      429: {
        description: "Full health probe rate limit exceeded",
        content: { "application/json": { schema: { $ref: "#/components/schemas/HealthFailure" } } },
      },
      502: {
        description: "Configured remote service is unavailable",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ServiceCheck" } } },
      },
      503: {
        description: "Required service is unavailable, disabled, or unconfigured",
        content: { "application/json": { schema: { $ref: "#/components/schemas/HealthResponse" } } },
      },
    },
  },
};

const routingHealthCheck = {
  get: {
    summary: "Routing-provider health check",
    responses: {
      200: {
        description: "Routing-provider diagnostic response",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ServiceCheck" } } },
      },
      405: {
        description: "Only GET is supported",
        content: { "application/json": { schema: { $ref: "#/components/schemas/HealthFailure" } } },
      },
      502: {
        description: "Routing provider is unavailable",
        content: { "application/json": { schema: { $ref: "#/components/schemas/HealthFailure" } } },
      },
      503: {
        description: "Routing provider is unconfigured",
        content: { "application/json": { schema: { $ref: "#/components/schemas/HealthFailure" } } },
      },
    },
  },
};

export const OPENAPI_DOCUMENT = Object.freeze({
  openapi: "3.1.0",
  info: {
    title: "Austin Hike & Bike Atlas API",
    version: "1.0.0",
    description: "Same-origin operational health endpoints. Responses never expose provider URLs or credentials.",
  },
  paths: {
    "/api/health": healthCheck,
    "/api/health/full": healthCheck,
    "/api/routing-health": routingHealthCheck,
    "/api/geocoding-health": healthCheck,
    "/api/routing-enrichment-health": healthCheck,
  },
  components: {
    schemas: {
      CheckStatus: {
        type: "string",
        enum: ["ok", "degraded", "disabled", "unconfigured", "unavailable", "outdated"],
      },
      ServiceCheck: {
        type: "object",
        required: ["status", "service"],
        properties: {
          status: { $ref: "#/components/schemas/CheckStatus" },
          service: { type: "string" },
          provider: { type: "string" },
          version: { type: "string" },
          routingGraphVersion: { type: "string" },
        },
      },
      LocalCheck: {
        type: "object",
        required: ["status"],
        properties: {
          status: { $ref: "#/components/schemas/CheckStatus" },
          expected: { type: "string" },
        },
      },
      HealthResponse: {
        type: "object",
        required: ["status"],
        properties: {
          status: { $ref: "#/components/schemas/CheckStatus" },
          checks: {
            type: "object",
            properties: {
              worker: { $ref: "#/components/schemas/LocalCheck" },
              database: { $ref: "#/components/schemas/LocalCheck" },
              migrations: { $ref: "#/components/schemas/LocalCheck" },
              routing: { $ref: "#/components/schemas/ServiceCheck" },
              geocoding: { $ref: "#/components/schemas/ServiceCheck" },
              routingEnrichment: { $ref: "#/components/schemas/ServiceCheck" },
            },
          },
        },
      },
      HealthFailure: {
        type: "object",
        required: ["status", "error"],
        properties: {
          status: { type: "string", enum: ["unavailable", "rate-limited"] },
          error: { type: "string" },
        },
      },
    },
  },
});

export function createOpenApiHandler() {
  return function handleOpenApi(request) {
    if (request.method !== "GET") {
      return Response.json(
        { status: "unavailable", error: "Method not allowed." },
        { status: 405, headers: { "Cache-Control": "no-store", Allow: "GET" } },
      );
    }
    return Response.json(OPENAPI_DOCUMENT, {
      headers: { "Cache-Control": "no-store" },
    });
  };
}
