import type { Metadata } from "next";
import Link from "next/link";
import HistoryPanel from "./history-panel";

export const metadata: Metadata = { title: "Ride history · Austin Hike & Bike Atlas" };

export default function HistoryPage() {
  return (
    <main className="account-history-shell">
      <header className="account-history-header">
        <div>
          <p className="eyebrow">Private route history</p>
          <h1>Your rides</h1>
        </div>
        <nav aria-label="History navigation">
          <Link href="/account">Account</Link>
          <Link href="/">Atlas</Link>
        </nav>
      </header>
      <HistoryPanel />
    </main>
  );
}
