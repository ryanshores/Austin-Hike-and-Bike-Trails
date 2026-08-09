#!/usr/bin/env bash
set -euo pipefail

readonly MINIMUM_AVAILABLE_KIB=$((20 * 1024 * 1024))

usage() {
  echo "Usage: $0 DATABASE_DIR VALHALLA_DATA_DIR" >&2
  echo "Prepare a persistent Austin-only Nominatim data directory." >&2
}

if [[ $# -ne 2 ]]; then
  usage
  exit 2
fi

readonly database_dir="$1"
readonly valhalla_data_dir="$2"
readonly source_pbf_path="$valhalla_data_dir/Austin.osm.pbf"
readonly source_provenance_path="$valhalla_data_dir/Austin.osm.pbf.provenance"
readonly nominatim_data_dir="$(dirname "$database_dir")/osm"
readonly destination_pbf_path="$nominatim_data_dir/Austin.osm.pbf"
readonly destination_provenance_path="$nominatim_data_dir/Austin.osm.pbf.provenance"

if [[ ! -s "$source_pbf_path" ]]; then
  echo "Missing Austin extract: $source_pbf_path" >&2
  exit 1
fi

if [[ ! -s "$source_provenance_path" ]]; then
  echo "Missing Austin extract provenance: $source_provenance_path" >&2
  exit 1
fi

mkdir -p "$database_dir" "$nominatim_data_dir"
readonly available_kib="$(df -Pk "$database_dir" | awk 'NR == 2 { print $4 }')"
if [[ ! "$available_kib" =~ ^[0-9]+$ ]] || (( available_kib < MINIMUM_AVAILABLE_KIB )); then
  echo "Nominatim requires at least 20 GiB free on the database filesystem; found ${available_kib:-unknown} KiB." >&2
  exit 1
fi

if [[ ! -f "$destination_pbf_path" ]] || ! cmp --silent "$source_pbf_path" "$destination_pbf_path"; then
  cp "$source_pbf_path" "$destination_pbf_path"
  cp "$source_provenance_path" "$destination_provenance_path"
fi

if ! cmp --silent "$source_pbf_path" "$destination_pbf_path"; then
  echo "Nominatim extract copy differs from the verified Valhalla source." >&2
  exit 1
fi

echo "Austin extract source: $source_pbf_path"
echo "Nominatim extract copy: $destination_pbf_path"
echo "Database directory: $database_dir"
echo "Available disk: $((available_kib / 1024 / 1024)) GiB"
echo "Preflight passed. Start Compose only after this check succeeds."
