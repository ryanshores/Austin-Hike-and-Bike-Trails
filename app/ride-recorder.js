const DATABASE_NAME = "austin-atlas-ride-recorder";
const DATABASE_VERSION = 1;
const ACTIVE_KEY = "active";
const MAX_BATCH_POINTS = 100;
const COMPLETION_RETRY_MS = 1_000;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("state", { keyPath: "key" });
      database.createObjectStore("points", { keyPath: "sequence" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open ride storage"));
  });
}

export async function clearLocalRideRecorder(rideId = null) {
  const database = await openDatabase();
  try {
    return await clearRideRecorderDatabase(database, rideId);
  } finally {
    database.close();
  }
}

export async function clearRideRecorderDatabase(database, rideId = null) {
  const transaction = database.transaction(["state", "points"], "readwrite");
  const state = transaction.objectStore("state");
  const active = await requestResult(state.get(ACTIVE_KEY));
  if (rideId !== null && active?.rideId !== rideId) {
    await transactionDone(transaction);
    return false;
  }
  state.delete(ACTIVE_KEY);
  transaction.objectStore("points").clear();
  await transactionDone(transaction);
  return true;
}

function uploadPoint(point) {
  return {
    sequence: point.sequence,
    recordedAt: point.recordedAt,
    latitude: point.latitude,
    longitude: point.longitude,
    accuracyMeters: point.accuracyMeters,
    altitudeMeters: point.altitudeMeters,
    speedMetersPerSecond: point.speedMetersPerSecond,
    headingDegrees: point.headingDegrees,
    quality: point.quality,
  };
}

export class RideRecorder {
  constructor({ fetcher = fetch } = {}) {
    this.fetcher = fetcher;
    this.databasePromise = openDatabase();
    this.flushing = null;
    this.recording = Promise.resolve();
  }

  async activeRide() {
    const database = await this.databasePromise;
    const transaction = database.transaction("state", "readonly");
    const value = await requestResult(transaction.objectStore("state").get(ACTIVE_KEY));
    await transactionDone(transaction);
    return value ?? null;
  }

  record(point) {
    const recording = this.recording.then(() => this.recordPoint(point));
    this.recording = recording.catch(() => {});
    return recording;
  }

  async recordPoint(point) {
    let active = await this.activeRide();
    if (!active) active = await this.createRide(point.recordedAt);
    const database = await this.databasePromise;
    const transaction = database.transaction(["state", "points"], "readwrite");
    const stored = { ...point, sequence: active.nextSequence };
    transaction.objectStore("points").put(stored);
    transaction.objectStore("state").put({ ...active, nextSequence: active.nextSequence + 1 });
    await transactionDone(transaction);
    this.flush().catch(() => {});
    return active.rideId;
  }

  async createRide(startedAt) {
    await this.ensureAnonymousSession();
    const rideId = crypto.randomUUID();
    const response = await this.fetcher("/api/rides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ id: rideId, startedAt }),
    });
    if (!response.ok) throw new Error("Could not start route history");
    const active = { key: ACTIVE_KEY, rideId, nextSequence: 0, startedAt };
    const database = await this.databasePromise;
    const transaction = database.transaction("state", "readwrite");
    transaction.objectStore("state").put(active);
    await transactionDone(transaction);
    return active;
  }

  async ensureAnonymousSession() {
    const response = await this.fetcher("/api/auth/anonymous", {
      method: "POST",
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Could not establish route-history session");
  }

  async queuedPoints() {
    const database = await this.databasePromise;
    const transaction = database.transaction("points", "readonly");
    const points = await requestResult(transaction.objectStore("points").getAll());
    await transactionDone(transaction);
    return points.sort((left, right) => left.sequence - right.sequence);
  }

  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushQueued().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async flushQueued() {
    const active = await this.activeRide();
    if (!active) return;
    const points = await this.queuedPoints();
    while (points.length) {
      const batch = await this.nextBatch(points);
      const response = await this.requestWithRefresh(`/api/rides/${active.rideId}/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ id: batch[0].batchId, points: batch.map(uploadPoint) }),
      });
      if (!response.ok) throw new Error("Could not upload saved route points");
      const database = await this.databasePromise;
      const transaction = database.transaction("points", "readwrite");
      for (const point of batch) transaction.objectStore("points").delete(point.sequence);
      await transactionDone(transaction);
      points.splice(0, batch.length);
    }
  }

  async nextBatch(points) {
    if (points[0].batchId) {
      return points.slice(0, MAX_BATCH_POINTS).filter((point) => point.batchId === points[0].batchId);
    }
    const batch = points.slice(0, MAX_BATCH_POINTS).filter((point) => !point.batchId);
    const id = crypto.randomUUID();
    const database = await this.databasePromise;
    const transaction = database.transaction("points", "readwrite");
    for (const point of batch) {
      point.batchId = id;
      transaction.objectStore("points").put(point);
    }
    await transactionDone(transaction);
    return batch;
  }

  async requestWithRefresh(url, options) {
    let response = await this.fetcher(url, options);
    if (response.status !== 401) return response;
    const refresh = await this.fetcher("/api/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
    });
    if (!refresh.ok) return response;
    response = await this.fetcher(url, options);
    return response;
  }

  async finish() {
    await this.recording;
    const active = await this.activeRide();
    if (!active) return;
    await this.flush();
    let response;
    do {
      response = await this.requestWithRefresh(`/api/rides/${active.rideId}/complete`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (response.status === 202) await new Promise((resolve) => setTimeout(resolve, COMPLETION_RETRY_MS));
    } while (response.status === 202);
    if (!response.ok) throw new Error("Could not finish route history");
    const database = await this.databasePromise;
    const transaction = database.transaction(["state", "points"], "readwrite");
    transaction.objectStore("state").delete(ACTIVE_KEY);
    transaction.objectStore("points").clear();
    await transactionDone(transaction);
  }
}
