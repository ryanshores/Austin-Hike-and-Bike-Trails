#!/usr/bin/env bash
set -euo pipefail

readonly DEFAULT_URL="https://download.bbbike.org/osm/bbbike/Austin/Austin.osm.pbf"

usage() {
  echo "Usage: $0 DATA_DIR EXPECTED_MD5 [EXTRACT_URL]" >&2
  echo "Download Austin.osm.pbf, verify its pinned MD5, and record its provenance." >&2
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 2
fi

readonly data_dir="$1"
readonly expected_md5="${2,,}"
readonly extract_url="${3:-$DEFAULT_URL}"

if [[ ! "$expected_md5" =~ ^[0-9a-f]{32}$ ]]; then
  echo "EXPECTED_MD5 must be exactly 32 hexadecimal characters." >&2
  exit 2
fi

mkdir -p "$data_dir"
readonly destination="$data_dir/Austin.osm.pbf"
readonly temporary="$data_dir/.Austin.osm.pbf.download"

cleanup() {
  rm -f "$temporary"
}
trap cleanup EXIT

curl --fail --location --show-error --output "$temporary" "$extract_url"
readonly actual_md5="$(md5sum "$temporary" | awk '{print $1}')"
if [[ "$actual_md5" != "$expected_md5" ]]; then
  echo "Austin extract checksum mismatch: expected $expected_md5, got $actual_md5." >&2
  exit 1
fi

mv "$temporary" "$destination"
trap - EXIT

readonly downloaded_at="$(date --utc +%Y-%m-%dT%H:%M:%SZ)"
cat > "$data_dir/Austin.osm.pbf.provenance" <<EOF
source=$extract_url
downloaded_at=$downloaded_at
md5=$actual_md5
EOF

echo "Prepared $destination"
echo "MD5: $actual_md5"
