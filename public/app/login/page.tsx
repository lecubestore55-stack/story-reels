"use client";

import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(data.error || "Login failed");
    window.location.href = "/";
  }

  return (
    <form onSubmit={submit} className="panel" style={{ maxWidth: 380, margin: "60px auto" }}>
      <h1>Log in</h1>
      <p className="muted small">Enter the admin password from your server's .env file.</p>
      <div className="field">
        <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
      </div>
      {error && <div className="alert bad">{error}</div>}
      <button className="primary" disabled={busy || !password}>{busy ? "Checking…" : "Log in"}</button>
    </form>
  );
}
