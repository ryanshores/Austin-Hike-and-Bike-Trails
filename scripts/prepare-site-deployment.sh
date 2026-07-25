#!/bin/sh
set -eu

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Commit tracked changes before preparing a Sites deployment." >&2
  exit 1
fi

sh scripts/select-site-target.sh --quiet

deployment_index=$(mktemp "${TMPDIR:-/tmp}/austin-atlas-sites-index.XXXXXX")
trap 'rm -f "$deployment_index"' EXIT

GIT_INDEX_FILE="$deployment_index" git read-tree HEAD
GIT_INDEX_FILE="$deployment_index" git add -f .openai/hosting.json
deployment_tree=$(GIT_INDEX_FILE="$deployment_index" git write-tree)
branch=$(git branch --show-current)
deployment_commit=$(printf 'Prepare %s Sites deployment\n' "$branch" | git commit-tree "$deployment_tree" -p HEAD)

echo "$deployment_commit"
