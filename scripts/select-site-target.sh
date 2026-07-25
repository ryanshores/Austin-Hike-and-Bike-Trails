#!/bin/sh
set -eu

quiet=false
if [ "${1:-}" = "--quiet" ]; then
  quiet=true
fi

branch=$(git branch --show-current)
case "$branch" in
  main)
    target=production
    ;;
  staging)
    target=staging
    ;;
  *)
    echo "No Sites target is assigned to branch '$branch'. Use main or staging." >&2
    exit 1
    ;;
esac

project_id=$(git config --local --get "sites.$target.projectId" || true)
case "$project_id" in
  appgprj_[a-z0-9]*)
    ;;
  *)
    echo "Missing or invalid local Sites project ID for '$target'." >&2
    echo "Set it with: git config --local sites.$target.projectId PROJECT_ID" >&2
    exit 1
    ;;
esac

mkdir -p .openai
printf '{\n  "project_id": "%s",\n  "d1": null,\n  "r2": null\n}\n' "$project_id" > .openai/hosting.json

if [ "$quiet" = false ]; then
  echo "Selected $target Sites target for branch $branch."
fi
