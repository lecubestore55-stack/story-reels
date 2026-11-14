"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Not logged in");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export const postJson = (url: string, body: unknown, method = "POST") =>
  api(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Fetch a resource and keep refreshing it while `shouldPoll(data)` is true. */
export function usePolling<T>(url: string, shouldPoll: (d: T) => boolean, everyMs = 3000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef(shouldPoll);
  pollRef.current = shouldPoll;

  const reload = useCallback(async () => {
    try {
      setData(await api<T>(url));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [url]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const d = await api<T>(url);
        if (!alive) return;
        setData(d);
        setError(null);
        timer = setTimeout(tick, pollRef.current(d) ? everyMs : everyMs * 5);
      } catch (e: any) {
        if (!alive) return;
        setError(e.message);
        timer = setTimeout(tick, everyMs * 3);
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [url, everyMs]);

  return { data, error, reload, setData };
}

const STATUS_STYLE: Record<string, string> = {
  ready: "ok", done: "ok", story_review: "warn", characters_review: "warn", frames_review: "warn",
  failed: "bad", uploaded: "run", analyzing: "run", writing: "run", characters: "run",
  frames: "run", clips: "run", rendering: "run", generating: "run", pending: "",
};
const STATUS_LABEL: Record<string, string> = {
  story_review: "story ready — review", characters_review: "characters ready — review",
  frames_review: "frames ready — review", clips: "generating video", rendering: "rendering MP4",
  writing: "writing story", characters: "making characters", frames: "making frames",
};

export function Badge({ status }: { status: string }) {
  const cls = STATUS_STYLE[status] ?? "";
  return (
    <span className={`badge ${cls}`}>
      {cls === "run" && <span className="spin" style={{ width: 9, height: 9, marginRight: 5, verticalAlign: -1 }} />}
      {STATUS_LABEL[status] || status}
    </span>
  );
}

export function LogoutButton() {
  return (
    <button
      className="link"
      onClick={async () => {
        await fetch("/api/logout", { method: "POST" });
        window.location.href = "/login";
      }}
    >
      Log out
    </button>
  );
}

export const money = (n: number | string | null | undefined) => `$${Number(n || 0).toFixed(2)}`;
