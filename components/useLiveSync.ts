"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isLiveFresh, receiveLiveSnapshot, type LiveSession, type LiveStateResponse } from "@/lib/live-state";

type SyncState = LiveSession & {
  enabled: boolean;
  status: "connected" | "stale" | "waiting" | "unavailable";
  message: string;
};

const initial: SyncState = { enabled: false, snapshot: null, candidate: null, status: "waiting", message: "Waiting for a running Mayhem game." };

export function useLiveSync() {
  const [sync, setSync] = useState<SyncState>(initial);
  const [now, setNow] = useState(0);
  const current = useRef(sync);
  const generation = useRef(0);
  const inFlight = useRef<Promise<SyncState> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const update = useCallback((next: SyncState) => {
    current.current = next;
    if (mounted.current) { setSync(next); setNow(Date.now()); }
    return next;
  }, []);

  const refresh = useCallback((): Promise<SyncState> => {
    if (!current.current.enabled) return Promise.resolve(current.current);
    if (inFlight.current) return inFlight.current;
    const epoch = generation.current;
    const abort = new AbortController();
    controller.current = abort;
    const timeout = window.setTimeout(() => abort.abort(), 4_000);
    const task = (async () => {
      try {
        const response = await fetch("/api/live-state", {
          headers: { "X-Mayhem-Live": "1" }, cache: "no-store", credentials: "omit", signal: abort.signal,
        });
        const result = await response.json() as LiveStateResponse;
        if (generation.current !== epoch || !mounted.current) return current.current;
        if (response.ok && result.ok) {
          const session = receiveLiveSnapshot(current.current, result.snapshot);
          return update({ ...current.current, ...session,
            status: session.candidate ? "waiting" : "connected",
            message: session.candidate
              ? "Confirm that this is your current ARAM Mayhem game before attaching live data."
              : "Champion, enemy team, items and stats are synchronized. Crit and augments stay manual.",
          });
        }
        return update({ ...current.current,
          status: current.current.snapshot ? "stale" : result.ok ? "unavailable" : result.status,
          message: result.ok ? "The local Live Sync endpoint is unavailable." : result.message,
        });
      } catch {
        if (generation.current !== epoch || !mounted.current) return current.current;
        return update({ ...current.current, status: current.current.snapshot ? "stale" : "unavailable",
          message: "Live Sync could not refresh. Retry or disable it to use manual entry.",
        });
      } finally {
        window.clearTimeout(timeout);
        controller.current = null;
      }
    })();
    inFlight.current = task;
    void task.finally(() => { if (inFlight.current === task) inFlight.current = null; });
    return task;
  }, [update]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; controller.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!sync.enabled) return;
    const tick = () => {
      setNow(Date.now());
      if (document.visibilityState === "visible") void refresh();
    };
    tick();
    const timer = window.setInterval(tick, 2_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh, sync.enabled]);

  function setEnabled(enabled: boolean) {
    generation.current++;
    controller.current?.abort();
    update({ ...initial, enabled });
  }
  function resetSession() {
    generation.current++;
    controller.current?.abort();
    update({ ...initial, enabled: current.current.enabled });
  }
  function attach() {
    const candidate = current.current.candidate;
    if (!isLiveFresh(candidate, Date.now()) || current.current.status !== "waiting") return;
    update({ ...current.current, snapshot: candidate, candidate: null, status: "connected",
      message: "Attached to the confirmed Mayhem game. Augments and crit stay manual.",
    });
  }

  const attached = sync.enabled && !sync.candidate && sync.snapshot !== null;
  const fresh = attached && sync.status === "connected" && isLiveFresh(sync.snapshot, now);
  return { ...sync, now, attached, fresh, refresh, setEnabled, resetSession, attach,
    status: attached && !isLiveFresh(sync.snapshot, now) ? "stale" as const : sync.status,
    message: attached && !isLiveFresh(sync.snapshot, now)
      ? "Live observations are stale. Manual values are shown; refresh or disable Live Sync before requesting a recommendation."
      : sync.message,
  };
}
