import type { Metadata } from "next";
import Link from "next/link";
import AccountPanel from "./account-panel";

export const metadata: Metadata = { title: "Account · Austin Trails" };

export default function AccountPage() {
  return (
    <main className="account-history-shell">
      <header className="account-history-header">
        <div>
          <p className="eyebrow">Private route history</p>
          <h1>Your account</h1>
        </div>
        <nav aria-label="Account navigation">
          <Link href="/history">History</Link>
          <Link href="/">Trails</Link>
        </nav>
      </header>
      <AccountPanel />
    </main>
  );
}
