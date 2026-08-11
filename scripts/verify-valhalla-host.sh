#!/usr/bin/env bash
set -euo pipefail

readonly status_url="${VALHALLA_STATUS_URL:-http://127.0.0.1:8002/status}"
readonly base_url="${status_url%/status}"
readonly enrichment_url="${ROUTING_ENRICHMENT_URL:-http://127.0.0.1:8003}"
readonly verify_routing_enrichment="${VERIFY_ROUTING_ENRICHMENT:-false}"

echo "Listening socket:"
ss -ltn | awk 'NR == 1 || /127\.0\.0\.1:8002|127\.0\.0\.1:8003/'

if ss -ltn | grep -Eq '(^|[[:space:]])(0\.0\.0\.0|\[::\]|\*):(8002|8003)([[:space:]]|$)'; then
  echo "Routing provider or enrichment port is exposed beyond localhost." >&2
  exit 1
fi

echo "Valhalla status:"
curl --fail --silent --show-error "$status_url"
echo

if [[ "$verify_routing_enrichment" == "true" ]]; then
  echo "Routing enrichment sidecar:"
  curl --fail --silent --show-error "$enrichment_url/health"
  echo
else
  echo "Routing enrichment sidecar: skipped (set VERIFY_ROUTING_ENRICHMENT=true after installing SQLite data)"
fi

python3 - "$base_url" <<'PY'
import json
import sys
from urllib.request import Request, urlopen

base_url = sys.argv[1]
route_body = json.dumps({
    "locations": [
        {"lat": 30.2672, "lon": -97.7431},
        {"lat": 30.285, "lon": -97.735},
    ],
    "costing": "bicycle",
    "units": "miles",
}).encode()
route_request = Request(
    f"{base_url}/route",
    data=route_body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urlopen(route_request, timeout=30) as response:
    route = json.load(response)

trip = route.get("trip", {})
legs = trip.get("legs", [])
if trip.get("status") != 0 or not legs or not legs[0].get("shape"):
    raise SystemExit("Valhalla did not return a usable Austin bicycle route.")

height_body = json.dumps({
    "encoded_polyline": legs[0]["shape"],
    "shape_format": "polyline6",
    "range": True,
    "resample_distance": 30,
}).encode()
height_request = Request(
    f"{base_url}/height",
    data=height_body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urlopen(height_request, timeout=30) as response:
    height = json.load(response)

samples = height.get("range_height", [])
if len(samples) < 2:
    raise SystemExit("Valhalla did not return a usable elevation profile.")

trace_body = json.dumps({
    "encoded_polyline": legs[0]["shape"],
    "shape_match": "edge_walk",
    "costing": "bicycle",
    "costing_options": {"bicycle": {"bicycle_type": "hybrid"}},
    "units": "miles",
    "filters": {
        "attributes": [
            "edge.id",
            "edge.way_id",
            "edge.length",
            "edge.begin_shape_index",
            "edge.end_shape_index",
            "shape",
        ],
        "action": "include",
    },
}).encode()
trace_request = Request(
    f"{base_url}/trace_attributes",
    data=trace_body,
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urlopen(trace_request, timeout=30) as response:
    attribution = json.load(response)

attributed_edges = attribution.get("edges", [])
if not attributed_edges:
    raise SystemExit("Valhalla did not return route edge attribution.")
if any(edge.get("id") is None for edge in attributed_edges):
    raise SystemExit("Valhalla returned an attributed edge without a stable graph ID.")
if any(not isinstance(edge.get("length"), (int, float)) or edge["length"] < 0 for edge in attributed_edges):
    raise SystemExit("Valhalla returned an attributed edge without a usable length.")

summary = trip.get("summary", {})
print(
    "Austin bicycle route: "
    f"{summary.get('length')} mi, {len(legs)} leg(s), "
    f"{len(legs[0].get('maneuvers', []))} maneuver(s)"
)
print(f"Elevation profile: {len(samples)} samples")
print(
    "Route edge attribution: "
    f"{len(attributed_edges)} graph edge(s), "
    f"{sum(edge.get('way_id') is not None for edge in attributed_edges)} with OSM way ID"
)
PY
