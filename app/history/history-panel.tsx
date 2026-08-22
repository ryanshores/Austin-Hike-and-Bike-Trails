"use client";

import { useEffect, useState } from "react";
import { apiRequest, ensureUser, readJson } from "../account-history-api";
import type { TrailsUser, RideSummary } from "../account-history-api";
import { clearLocalRideRecorder } from "../ride-recorder";

type HistoryPage = { nextCursor: string | null; rides: RideSummary[] };

export default function HistoryPanel() {
  const [user, setUser] = useState<TrailsUser | null>(null);
  const [rides, setRides] = useState<RideSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading private ride history…");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        const identity = await ensureUser();
        const page = await loadHistory();
        if (!active) return;
        setUser(identity.user);
        setRides(page.rides);
        setCursor(page.nextCursor);
        setStatus("");
      } catch (error) {
        if (active) setStatus(error instanceof Error ? error.message : "History unavailable");
      }
    }
    void initialize();
    return () => { active = false; };
  }, []);

  async function loadMore() {
    if (!cursor) return;
    setBusy(true);
    setStatus("Loading older rides…");
    try {
      const page = await loadHistory(cursor);
      setRides((current) => [...current, ...page.rides]);
      setCursor(page.nextCursor);
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load older rides");
    } finally {
      setBusy(false);
    }
  }

  async function deleteRide(id: string) {
    setBusy(true);
    setStatus("Deleting ride…");
    try {
      const response = await apiRequest(`/api/rides/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not delete the ride");
      const recorderCleared = await clearMatchingRecorderSafely(id);
      setRides((current) => current.filter((ride) => ride.id !== id));
      setConfirming(null);
      setStatus(recorderCleared
        ? "Ride and route points were permanently deleted."
        : "The server ride was deleted, but this browser could not clear its queued points. Clear this site's browser data before using Ride Mode.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete the ride");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="history-panel">
      {user?.accountType === "anonymous" && <div className="history-notice"><strong>History belongs to this browser.</strong><span>Create an account to preserve it and use it on another device.</span></div>}
      {status && <p className="form-status" aria-live="polite">{status}</p>}
      {!status && rides.length === 0 && <div className="empty-history"><h2>No saved rides yet</h2><p>Start Ride Mode; the first trustworthy GPS fix will create your private ride.</p></div>}
      <div className="ride-list">
        {rides.map((ride) => (
          <article className="ride-card" key={ride.id}>
            <div>
              <p className="eyebrow">{new Date(ride.startedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}</p>
              <h2>{ride.title || (ride.status === "recording" ? "Ride in progress" : "Completed ride")}</h2>
              <dl><div><dt>Distance</dt><dd>{formatDistance(ride.distanceMeters)}</dd></div><div><dt>Duration</dt><dd>{formatDuration(ride)}</dd></div><div><dt>Points</dt><dd>{ride.acceptedPointCount.toLocaleString()}</dd></div></dl>
            </div>
            {confirming === ride.id
              ? <div className="confirm-actions"><button className="danger-action" onClick={() => deleteRide(ride.id)} disabled={busy}>Delete permanently</button><button className="secondary-action" onClick={() => setConfirming(null)} disabled={busy}>Cancel</button></div>
              : <button className="secondary-action" onClick={() => setConfirming(ride.id)} disabled={busy}>Delete ride</button>}
          </article>
        ))}
      </div>
      {cursor && <button className="load-more" onClick={loadMore} disabled={busy}>Load older rides</button>}
    </section>
  );
}

async function clearMatchingRecorderSafely(id: string) {
  try {
    await clearLocalRideRecorder(id);
    return true;
  } catch {
    return false;
  }
}

async function loadHistory(cursor?: string) {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor) query.set("cursor", cursor);
  return readJson<HistoryPage>(await apiRequest(`/api/rides?${query}`));
}

function formatDistance(meters: number) {
  return `${(meters / 1609.344).toFixed(meters < 1609.344 ? 2 : 1)} mi`;
}

function formatDuration(ride: RideSummary) {
  if (ride.endedAt === null) return "In progress";
  const minutes = Math.max(0, Math.round((ride.endedAt - ride.startedAt) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}
