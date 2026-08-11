import { providerEndpoint } from "./api-utils.js";

// D1 permits at most 100 bound parameters per query. One belongs to the graph
// version, leaving at most 99 exact edge IDs in a single lookup.
const MAX_EDGE_IDS_PER_QUERY = 99;
const MAX_EDGE_IDS_PER_SIDECAR_REQUEST = 500;
const MAX_SIDECAR_REQUEST_BYTES = 65_536;

export function routingEnrichmentEnabled(value) {
  return value === "true";
}

function validId(value) {
  const id = String(value ?? "").trim();
  return id && id.length <= 256 ? id : null;
}

function jsonObject(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedRecord(row) {
  const edgeId = validId(row?.edge_id);
  const osm = jsonObject(row?.osm_json);
  const classification = jsonObject(row?.classification_json);
  const cityMatch = jsonObject(row?.city_match_json);
  const city = row?.city_json === null ? null : jsonObject(row?.city_json);
  const travelDirection = row?.travel_direction === null ? null : String(row?.travel_direction ?? "");
  if (
    !edgeId ||
    !osm ||
    !classification ||
    !cityMatch ||
    (row?.city_json !== null && !city) ||
    ![null, "forward", "backward"].includes(travelDirection)
  ) {
    return null;
  }
  return {
    edgeId,
    osm,
    city,
    travelDirection,
    classification,
  };
}

function normalizedSidecarRecord(value) {
  const edgeId = validId(value?.edgeId);
  const osm = value?.osm && typeof value.osm === "object" && !Array.isArray(value.osm)
    ? value.osm
    : null;
  const classification = value?.classification &&
    typeof value.classification === "object" && !Array.isArray(value.classification)
    ? value.classification
    : null;
  const cityMatch = value?.cityMatch && typeof value.cityMatch === "object" && !Array.isArray(value.cityMatch)
    ? value.cityMatch
    : null;
  const city = value?.city === null
    ? null
    : value?.city && typeof value.city === "object" && !Array.isArray(value.city)
      ? value.city
      : null;
  const travelDirection = value?.travelDirection === null
    ? null
    : String(value?.travelDirection ?? "");
  if (
    !edgeId ||
    !osm ||
    !classification ||
    !cityMatch ||
    (value?.city !== null && !city) ||
    ![null, "forward", "backward"].includes(travelDirection)
  ) {
    return null;
  }
  return { edgeId, osm, city, travelDirection, classification };
}

function accessHeaders(accessClientId, accessClientSecret) {
  if (!accessClientId || !accessClientSecret) return null;
  return {
    "CF-Access-Client-Id": accessClientId,
    "CF-Access-Client-Secret": accessClientSecret,
  };
}

function sidecarRequestBody(routingGraphVersion, edgeIds) {
  return JSON.stringify({ routingGraphVersion, edgeIds });
}

function sidecarBatches(routingGraphVersion, edgeIds) {
  const batches = [];
  let batch = [];
  for (const edgeId of edgeIds) {
    const candidate = [...batch, edgeId];
    const candidateBody = sidecarRequestBody(routingGraphVersion, candidate);
    const exceedsLimit = candidate.length > MAX_EDGE_IDS_PER_SIDECAR_REQUEST ||
      new TextEncoder().encode(candidateBody).byteLength > MAX_SIDECAR_REQUEST_BYTES;
    if (exceedsLimit && batch.length > 0) {
      batches.push({ edgeIds: batch, body: sidecarRequestBody(routingGraphVersion, batch) });
      batch = [edgeId];
    } else {
      batch = candidate;
    }
  }
  if (batch.length > 0) {
    batches.push({ edgeIds: batch, body: sidecarRequestBody(routingGraphVersion, batch) });
  }
  return batches;
}

/**
 * Reads an already-verified routing-enrichment sidecar by graph version and
 * exact Valhalla edge ID. All variable values are bound, and large route
 * responses are chunked so an upstream route cannot create an unbounded SQL
 * statement.
 */
export function createD1RoutingEnrichmentStore(database) {
  return {
    async lookup({ routingGraphVersion, edgeIds } = {}) {
      const graphVersion = validId(routingGraphVersion);
      if (!graphVersion || !database?.prepare || !Array.isArray(edgeIds)) return new Map();

      const uniqueIds = [...new Set(edgeIds.map(validId).filter(Boolean))];
      const records = new Map();
      for (let index = 0; index < uniqueIds.length; index += MAX_EDGE_IDS_PER_QUERY) {
        const ids = uniqueIds.slice(index, index + MAX_EDGE_IDS_PER_QUERY);
        const placeholders = ids.map(() => "?").join(", ");
        const result = await database.prepare(
          `SELECT edge_id, travel_direction, city_match_json, city_json, osm_json, classification_json
           FROM routing_edge_enrichments
           WHERE routing_graph_version = ? AND edge_id IN (${placeholders})`,
        ).bind(graphVersion, ...ids).all();
        for (const row of result.results ?? []) {
          const record = normalizedRecord(row);
          if (record) records.set(record.edgeId, record);
        }
      }
      return records;
    },
  };
}

/**
 * Reads the private SQLite sidecar through its Access-protected HTTP API.
 * A response is usable only when it echoes the requested graph version and
 * supplies structurally valid exact-ID records; callers conservatively treat
 * lookup failures and omitted records as unknown route edges.
 */
export function createSqliteRoutingEnrichmentStore({
  sidecarUrl,
  accessClientId,
  accessClientSecret,
  fetchImpl = fetch,
} = {}) {
  const headers = accessHeaders(accessClientId, accessClientSecret);
  if (!sidecarUrl || !headers) return null;

  return {
    async lookup({ routingGraphVersion, edgeIds, signal } = {}) {
      const graphVersion = validId(routingGraphVersion);
      if (!graphVersion || !Array.isArray(edgeIds)) return new Map();

      const uniqueIds = [...new Set(edgeIds.map(validId).filter(Boolean))];
      const records = new Map();
      for (const batch of sidecarBatches(graphVersion, uniqueIds)) {
        const endpoint = providerEndpoint(sidecarUrl, "/v1/lookup");
        const response = await fetchImpl(endpoint, {
          method: "POST",
          redirect: "manual",
          headers: {
            ...headers,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: batch.body,
          signal,
        });
        if (!response.ok) {
          throw new Error(`routing enrichment sidecar returned HTTP ${response.status}`);
        }
        if (response.url && new URL(response.url).origin !== endpoint.origin) {
          throw new Error("routing enrichment sidecar returned an unexpected origin");
        }
        const payload = await response.json();
        if (
          payload?.routingGraphVersion !== graphVersion ||
          !Array.isArray(payload?.records)
        ) {
          throw new Error("routing enrichment sidecar returned an invalid lookup response");
        }
        for (const value of payload.records) {
          const record = normalizedSidecarRecord(value);
          if (record && batch.edgeIds.includes(record.edgeId)) records.set(record.edgeId, record);
        }
      }
      return records;
    },
  };
}
