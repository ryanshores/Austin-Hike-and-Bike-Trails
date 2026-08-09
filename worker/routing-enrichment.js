// D1 permits at most 100 bound parameters per query. One belongs to the graph
// version, leaving at most 99 exact edge IDs in a single lookup.
const MAX_EDGE_IDS_PER_QUERY = 99;

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
