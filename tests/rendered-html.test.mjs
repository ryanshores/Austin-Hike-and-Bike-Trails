import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Austin trail atlas", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Austin Hike &amp; Bike Atlas<\/title>/i);
  assert.match(html, /Hike &amp; Bike Atlas/);
  assert.match(html, /Interactive map of Austin hike and bike paths/);
  assert.match(html, /Start moving ride map/);
  assert.match(html, /Trail safety legend/);
});

test("renders location status as an accessible live region", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /class="map-stamp" aria-live="polite"/);
  assert.match(html, /Loading City of Austin trail data/);
});
