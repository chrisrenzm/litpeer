"use client";

import { useState } from "react";

export default function Login() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        const next = new URLSearchParams(window.location.search).get("next");
        window.location.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Could not sign in.");
    } catch {
      setError("Network error. Try again.");
    }
    setBusy(false);
  }

  return (
    <main className="gate">
      <form className="gatecard" onSubmit={submit}>
        <div className="brand gatebrand">Lit<span>Peer</span></div>
        <p className="gatesub">Cited answers from biology, healthcare and drug discovery literature. Enter the password to continue.</p>
        <input
          className="gateinput"
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Password"
        />
        {error && <div className="gateerr" role="alert">{error}</div>}
        <button className="gatebtn" type="submit" disabled={busy || !password}>
          {busy ? "Checking…" : "Enter"}
        </button>
      </form>
    </main>
  );
}
