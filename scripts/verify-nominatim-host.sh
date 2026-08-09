#!/usr/bin/env bash
set -euo pipefail

readonly base_url="${NOMINATIM_BASE_URL:-http://127.0.0.1:8082}"

echo "Listening socket:"
ss -ltn | awk 'NR == 1 || /127\.0\.0\.1:8082/'

if ss -ltn | grep -Eq '(^|[[:space:]])(0\.0\.0\.0|\[::\]|\*):8082([[:space:]]|$)'; then
  echo "Nominatim port 8082 is exposed beyond localhost." >&2
  exit 1
fi

echo "Nominatim status:"
curl --fail --silent --show-error "$base_url/status"
echo

python3 - "$base_url" <<'PY'
import json
import sys
from urllib.parse import urlencode
from urllib.request import urlopen

base_url = sys.argv[1].rstrip("/")
params = urlencode({
    "q": "Austin Central Library",
    "format": "jsonv2",
    "addressdetails": "1",
    "limit": "5",
    "viewbox": "-98.35,30.85,-97.05,29.7",
    "bounded": "1",
})
with urlopen(f"{base_url}/search?{params}", timeout=30) as response:
    results = json.load(response)

if not isinstance(results, list) or not results:
    raise SystemExit("Nominatim did not return an Austin search result.")

first = results[0]
if not first.get("display_name") or not first.get("lat") or not first.get("lon"):
    raise SystemExit("Nominatim returned an incomplete search result.")

print(f"Austin search result: {first['display_name']}")
PY
