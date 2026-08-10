import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const wranglerPath = new URL("../wrangler.jsonc", import.meta.url);

function rateLimitBindings(section) {
  return [...section.matchAll(/"name": "(GEOCODE_RATE_LIMITER|ROUTE_RATE_LIMITER)",\s*"namespace_id": "(\d+)",\s*"simple": \{\s*"limit": (\d+),\s*"period": (\d+)/g)]
    .map(([, name, namespaceId, limit, period]) => ({
      name,
      namespaceId,
      limit: Number(limit),
      period: Number(period),
    }));
}

test("production and preview bind isolated route and geocode request limits", async () => {
  const wrangler = await readFile(wranglerPath, "utf8");
  const previewOffset = wrangler.indexOf('"preview": {');
  assert.notEqual(previewOffset, -1, "preview environment missing");
  const productionBindings = rateLimitBindings(wrangler.slice(0, previewOffset));
  const previewBindings = rateLimitBindings(wrangler.slice(previewOffset));

  assert.deepEqual(
    productionBindings.map(({ name, limit, period }) => ({ name, limit, period })),
    [
      { name: "GEOCODE_RATE_LIMITER", limit: 30, period: 60 },
      { name: "ROUTE_RATE_LIMITER", limit: 15, period: 60 },
    ],
  );
  assert.deepEqual(
    previewBindings.map(({ name, limit, period }) => ({ name, limit, period })),
    [
      { name: "GEOCODE_RATE_LIMITER", limit: 30, period: 60 },
      { name: "ROUTE_RATE_LIMITER", limit: 15, period: 60 },
    ],
  );
  assert.equal(new Set([...productionBindings, ...previewBindings].map(({ namespaceId }) => namespaceId)).size, 4);
});
