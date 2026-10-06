import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
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

test("server-renders Austin Trails", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Austin Trails<\/title>/i);
  assert.match(html, /Austin Trails/);
  assert.match(html, /Interactive map of Austin hike and bike paths/);
  assert.match(html, /Open full-screen ride map/);
  assert.match(html, /Find a trail or bike route/);
  assert.match(html, /Plan a bicycle route/);
  assert.match(html, /Use my location/);
  assert.match(html, /Choose on map/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-autocomplete="list"/);
  assert.match(html, /After searching, use the up and down arrow keys/);
  assert.match(html, /Bike facilities or safer/);
  assert.match(html, /Bicycle-legal streets may still be used/);
  assert.match(html, /Trail safety legend/);
  assert.match(html, /My ride heat/);
  assert.match(html, /Private, distance-based route activity/);
  assert.doesNotMatch(html, /\bETA\b|arrival time|trip duration/i);
  assert.match(html, /href="\/history"/);
  assert.match(html, /href="\/account"/);
});

test("renders location status as an accessible live region", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /class="map-stamp" aria-live="polite"/);
  assert.match(html, /Loading City of Austin trail data/);
});

test("server-renders the dedicated full-screen ride page", async () => {
  const response = await render("/ride");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Full-screen moving ride map/);
  assert.match(html, /Ready to ride/);
  assert.match(html, /Start GPS/);
  assert.match(html, /GPS diagnostics/);
  assert.match(html, /My ride heat/);
  assert.doesNotMatch(html, /Find a trail or bike route/);
});

test("server-renders the private account entry point", async () => {
  const response = await render("/account");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>Account · Austin Trails<\/title>/i);
  assert.match(html, /Your account/);
  assert.match(html, /Loading your private account/);
  assert.match(html, /href="\/history"/);
});

test("server-renders the private ride-history entry point", async () => {
  const response = await render("/history");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>Ride history · Austin Trails<\/title>/i);
  assert.match(html, /Your rides/);
  assert.match(html, /Loading private ride history/);
  assert.match(html, /href="\/account"/);
});
