// The website talks to the Join server with the person's session cookie. Agents never use these routes; they use
// /mcp or /api/agent with their own token.
import { useCallback, useEffect, useState } from "react";

export async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(path, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || j.error || `HTTP ${r.status}`), { status: r.status, body: j });
  return j;
}

// a GET that loads on mount and again on reload() or whenever `tick` changes
export function useApi(path, tick = 0) {
  const [state, set] = useState({ data: null, error: null, loading: true });
  const load = useCallback(() => {
    let off = false;
    api(path).then((data) => !off && set({ data, error: null, loading: false })).catch((error) => !off && set((s) => ({ ...s, error, loading: false })));
    return () => { off = true; };
  }, [path]);
  useEffect(load, [load, tick]);
  return { ...state, reload: load };
}

// the signed-in person's activity, live: the log so far, then each new entry as the server sends it
export function useActivity(enabled) {
  const [entries, setEntries] = useState([]);
  useEffect(() => {
    if (!enabled) return;
    let es = null, off = false;
    api("/api/activity").then((r) => {
      if (off) return;
      setEntries(r.entries);
      es = new EventSource("/api/activity/stream");
      es.onmessage = (m) => { const e = JSON.parse(m.data); setEntries((xs) => (xs.some((x) => x.id === e.id) ? xs : [...xs, e])); };
    }).catch(() => {});
    return () => { off = true; es?.close(); };
  }, [enabled]);
  return entries;
}

export const money = (x) => `$${(+x).toFixed(2)}`;
export const when = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const dayLabel = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
