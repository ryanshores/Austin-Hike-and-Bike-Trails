import assert from "node:assert/strict";
import test from "node:test";
import { clearRideRecorderDatabase } from "../app/ride-recorder.js";

function request(result) {
  const pending = {};
  queueMicrotask(() => {
    pending.result = result;
    pending.onsuccess?.();
  });
  return pending;
}

function databaseWith(active, points = []) {
  const values = {
    points: new Map(points.map((point) => [point.sequence, point])),
    state: new Map(active ? [["active", active]] : []),
  };
  return {
    values,
    transaction() {
      const transaction = {
        objectStore(name) {
          const store = values[name];
          return {
            clear: () => store.clear(),
            delete: (key) => store.delete(key),
            get: (key) => request(store.get(key)),
          };
        },
      };
      Object.defineProperty(transaction, "oncomplete", {
        set(handler) { queueMicrotask(handler); },
      });
      return transaction;
    },
  };
}

test("clears an active ride and all queued points when the ride matches", async () => {
  const database = databaseWith(
    { key: "active", rideId: "ride-1" },
    [{ sequence: 0 }, { sequence: 1 }],
  );

  assert.equal(await clearRideRecorderDatabase(database, "ride-1"), true);
  assert.equal(database.values.state.size, 0);
  assert.equal(database.values.points.size, 0);
});

test("preserves recorder state when deleting a different ride", async () => {
  const database = databaseWith(
    { key: "active", rideId: "ride-1" },
    [{ sequence: 0 }],
  );

  assert.equal(await clearRideRecorderDatabase(database, "ride-2"), false);
  assert.equal(database.values.state.get("active").rideId, "ride-1");
  assert.equal(database.values.points.size, 1);
});

test("clears all recorder state when an identity changes", async () => {
  const database = databaseWith(
    { key: "active", rideId: "ride-1" },
    [{ sequence: 0 }],
  );

  assert.equal(await clearRideRecorderDatabase(database), true);
  assert.equal(database.values.state.size, 0);
  assert.equal(database.values.points.size, 0);
});
