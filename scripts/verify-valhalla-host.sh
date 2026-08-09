#!/usr/bin/env bash
set -euo pipefail

readonly status_url="${VALHALLA_STATUS_URL:-http://127.0.0.1:8002/status}"
readonly base_url="${status_url%/status}"

echo "Listening socket:"
ss -ltn | awk 'NR == 1 || /127\.0\.0\.1:8002/'

if ss -ltn | grep -Eq '(^|[[:space:]])(0\.0\.0\.0|\[::\]|\*):8002([[:space:]]|$)'; then
  echo "Valhalla port 8002 is exposed beyond localhost." >&2
  exit 1
fi

echo "Valhalla status:"
curl --fail --silent --show-error "$status_url"
echo

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

summary = trip.get("summary", {})
print(
    "Austin bicycle route: "
    f"{summary.get('length')} mi, {len(legs)} leg(s), "
    f"{len(legs[0].get('maneuvers', []))} maneuver(s)"
)
print(f"Elevation profile: {len(samples)} samples")
PY
