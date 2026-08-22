import assert from "node:assert/strict";
import test from "node:test";

import {
  forwardMapBearing,
  installMapSizeSync,
  mapOptionsForMode,
  nextForwardMapBearing,
} from "../app/map-runtime.js";

test("Ride Mode uses SVG while Trails keeps the Canvas renderer", () => {
  assert.equal(mapOptionsForMode(true).preferCanvas, false);
  assert.equal(mapOptionsForMode(false).preferCanvas, true);
});

test("Forward Up rotates the map opposite the rider heading", () => {
  assert.equal(forwardMapBearing(0), 0);
  assert.equal(forwardMapBearing(90), 270);
  assert.equal(forwardMapBearing(180), 180);
  assert.equal(nextForwardMapBearing(0, 90), 328.5);
});

test("visual viewport changes invalidate the map size and listeners are cleaned up", () => {
  const listeners = new Map();
  const invalidations = [];
  let observedNode;
  let observerDisconnected = false;
  const mapNode = {};
  const map = {
    invalidateSize(options) {
      invalidations.push(options);
    },
  };
  const visualViewport = {
    addEventListener(event, listener) {
      listeners.set(event, listener);
    },
    removeEventListener(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
  };
  class ResizeObserverMock {
    constructor(callback) {
      listeners.set("observer", callback);
    }

    observe(node) {
      observedNode = node;
    }

    disconnect() {
      observerDisconnected = true;
    }
  }
  const windowObject = {
    visualViewport,
    requestAnimationFrame(callback) {
      callback();
    },
  };

  const sync = installMapSizeSync({
    map,
    mapNode,
    windowObject,
    ResizeObserverClass: ResizeObserverMock,
  });

  assert.equal(observedNode, mapNode);
  listeners.get("resize")();
  listeners.get("scroll")();
  listeners.get("observer")();
  assert.deepEqual(invalidations, [
    { animate: false, pan: false },
    { animate: false, pan: false },
    { animate: false, pan: false },
  ]);

  sync.disconnect();
  assert.equal(observerDisconnected, true);
  assert.equal(listeners.has("resize"), false);
  assert.equal(listeners.has("scroll"), false);
});
