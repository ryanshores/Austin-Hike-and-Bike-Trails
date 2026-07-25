import assert from "node:assert/strict";
import test from "node:test";

import { installMapSizeSync, mapOptionsForMode } from "../app/map-runtime.js";

test("Ride Mode uses SVG while Atlas keeps the Canvas renderer", () => {
  assert.equal(mapOptionsForMode(true).preferCanvas, false);
  assert.equal(mapOptionsForMode(false).preferCanvas, true);
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
