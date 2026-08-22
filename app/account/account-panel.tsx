"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { apiRequest, ensureUser, readJson } from "../account-history-api";
import type { TrailsUser } from "../account-history-api";
import { clearLocalRideRecorder } from "../ride-recorder";

type AuthResult = { retainedRideCount?: number; user: TrailsUser };

export default function AccountPanel() {
  const [user, setUser] = useState<TrailsUser | null>(null);
  const [status, setStatus] = useState("Loading your private account…");
  const [busy, setBusy] = useState(false);
  const [deleteStep, setDeleteStep] = useState(false);

  useEffect(() => {
    let active = true;
    ensureUser()
      .then(({ user: nextUser }) => {
        if (!active) return;
        setUser(nextUser);
        setStatus("");
      })
      .catch((error) => active && setStatus(error instanceof Error ? error.message : "Account unavailable"));
    return () => { active = false; };
  }, []);

  async function submitCredentials(event: FormEvent<HTMLFormElement>, action: "login" | "register") {
    event.preventDefault();
    const formElement = event.currentTarget;
    setBusy(true);
    setStatus(action === "register" ? "Creating your account…" : "Signing in…");
    const form = new FormData(formElement);
    try {
      const result = await readJson<AuthResult>(await apiRequest(`/api/auth/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      }));
      const recorderCleared = action !== "login" || result.user.id === user?.id
        ? true
        : await clearRecorderSafely();
      setUser(result.user);
      const returnTo = new URLSearchParams(window.location.search).get("returnTo");
      if (recorderCleared && returnTo === "/ride") {
        window.location.assign(returnTo);
        return;
      }
      setStatus(!recorderCleared
        ? "Signed in, but this browser could not clear an interrupted ride. Do not resume Ride Mode on this device."
        : action === "register"
          ? `${result.retainedRideCount ?? 0} existing ${result.retainedRideCount === 1 ? "ride was" : "rides were"} retained.`
          : "Signed in. Your account history is available on this device.");
      formElement.reset();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Account request failed");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setStatus("Signing out…");
    try {
      const response = await apiRequest("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Could not sign out");
      const recorderCleared = await clearRecorderSafely();
      const next = await ensureUser();
      setUser(next.user);
      setStatus(recorderCleared
        ? "Signed out. A new browser-only history has started."
        : "Signed out, but this browser could not clear an interrupted ride. Do not resume Ride Mode on this device.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not sign out");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    setBusy(true);
    setStatus("Deleting account and route history…");
    try {
      const response = await apiRequest("/api/auth/account", { method: "DELETE" });
      if (!response.ok) throw new Error("Could not delete the account");
      const recorderCleared = await clearRecorderSafely();
      const next = await ensureUser();
      setUser(next.user);
      setDeleteStep(false);
      setStatus(recorderCleared
        ? "Account and saved route history were permanently deleted."
        : "The server account was deleted, but this browser could not clear queued route points. Clear this site's browser data before using Ride Mode.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete the account");
    } finally {
      setBusy(false);
    }
  }

  if (!user) return <section className="account-card" aria-live="polite"><p>{status}</p></section>;

  return (
    <div className="account-grid">
      {user.accountType === "anonymous" && (
        <>
          <AuthForm title="Preserve this history" action="register" busy={busy} onSubmit={submitCredentials} />
          <AuthForm title="Use an existing account" action="login" busy={busy} onSubmit={submitCredentials} />
        </>
      )}

      <section className="account-card account-state" aria-live="polite">
        <p className="eyebrow">Current state</p>
        <h2>{user.accountType === "registered" ? "Registered account" : "This browser"}</h2>
        <p>{user.accountType === "registered"
          ? `Signed in as ${user.email}. Your rides can follow you to another device.`
          : "Your rides are privately associated with this browser. Create an account to preserve them and sign in elsewhere."}</p>
        {status && <p className="form-status">{status}</p>}
        {user.accountType === "registered" && <button className="secondary-action" onClick={logout} disabled={busy}>Sign out</button>}
      </section>

      <section className="account-card danger-card">
        <p className="eyebrow">Permanent deletion</p>
        <h2>Delete private history</h2>
        <p>This permanently removes this identity, every saved ride, and every route point. It cannot be undone.</p>
        {!deleteStep
          ? <button className="danger-action" onClick={() => setDeleteStep(true)} disabled={busy}>Delete account and history</button>
          : <div className="confirm-actions"><button className="danger-action" onClick={deleteAccount} disabled={busy}>Confirm permanent deletion</button><button className="secondary-action" onClick={() => setDeleteStep(false)} disabled={busy}>Cancel</button></div>}
      </section>
    </div>
  );
}

async function clearRecorderSafely() {
  try {
    await clearLocalRideRecorder();
    return true;
  } catch {
    return false;
  }
}

function AuthForm({ action, busy, onSubmit, title }: {
  action: "login" | "register";
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>, action: "login" | "register") => void;
  title: string;
}) {
  return (
    <form className="account-card account-form" onSubmit={(event) => onSubmit(event, action)}>
      <p className="eyebrow">{action === "register" ? "Create account" : "Sign in"}</p>
      <h2>{title}</h2>
      <label>Email<input name="email" type="email" autoComplete="email" required /></label>
      <label>Password<input name="password" type="password" minLength={12} maxLength={128} autoComplete={action === "register" ? "new-password" : "current-password"} required /></label>
      <button className="primary-action" disabled={busy}>{action === "register" ? "Create account" : "Sign in"}</button>
      <p className="form-note">Password recovery and email verification are not available yet. Signing in does not merge a different browser-only history.</p>
    </form>
  );
}
