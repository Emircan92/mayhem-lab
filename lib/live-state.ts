import type { ManualGameState, PlayerStats, SelectedAugment } from "./game-state";

export const LIVE_STALE_MS = 6_000;
export type LiveSnapshot = {
  observedAt: number;
  gameTime: number;
  gameMode: string;
  mapNumber: number;
  // Opaque roster fingerprint, not a Riot match ID. Never sufficient by itself.
  sessionKey: string;
  championId: number;
  enemyChampionIds: number[];
  inventory: Array<{ slot: number; itemId: number; count: number; known: boolean }>;
  stats: Omit<PlayerStats, "critChance">;
  warnings: string[];
};

export type LiveStateResponse =
  | { ok: true; snapshot: LiveSnapshot }
  | { ok: false; status: "waiting" | "unavailable"; message: string; diagnostic?: import("./diagnostics/schema").LiveDiagnostic };

export function isLiveFresh(snapshot: LiveSnapshot | null, now: number): snapshot is LiveSnapshot {
  return snapshot !== null && now >= snapshot.observedAt && now - snapshot.observedAt < LIVE_STALE_MS;
}

export type AttachmentReason = "initial-attachment" | "participants-changed" | "local-champion-changed" | "metadata-changed" | "clock-discontinuity";

export function liveAttachmentMismatch(previous: LiveSnapshot | null, next: LiveSnapshot): AttachmentReason | null {
  if (!previous) return "initial-attachment";
  if (previous.championId !== next.championId) return "local-champion-changed";
  if (previous.mapNumber !== next.mapNumber || previous.gameMode !== next.gameMode) return "metadata-changed";
  if (previous.sessionKey !== next.sessionKey) return "participants-changed";
  const wallElapsed = (next.observedAt - previous.observedAt) / 1000;
  const gameElapsed = next.gameTime - previous.gameTime;
  return wallElapsed >= 0 && gameElapsed >= -3 && Math.abs(gameElapsed - wallElapsed) <= 60
    ? null : "clock-discontinuity";
}

export function sameLiveGame(previous: LiveSnapshot, next: LiveSnapshot): boolean {
  return liveAttachmentMismatch(previous, next) === null;
}

export type LiveSession = { snapshot: LiveSnapshot | null; candidate: LiveSnapshot | null };

export function receiveLiveSnapshot(session: LiveSession, next: LiveSnapshot): LiveSession {
  // A pending boundary stays pending until the user explicitly attaches it.
  if (session.candidate || !session.snapshot || !sameLiveGame(session.snapshot, next)) {
    return { ...session, candidate: next };
  }
  return { snapshot: next, candidate: null };
}

export function mergeLiveState(
  manual: ManualGameState,
  snapshot: LiveSnapshot | null,
  enabled: boolean,
  now: number,
): ManualGameState {
  if (!enabled || !isLiveFresh(snapshot, now)) return manual;
  return {
    ...manual,
    championId: snapshot.championId,
    enemyChampionIds: [...snapshot.enemyChampionIds],
    itemIds: snapshot.inventory.map((entry) => entry.itemId),
    stats: {
      ...snapshot.stats,
      ...(manual.stats.critChance === undefined ? {} : { critChance: manual.stats.critChance }),
    },
  };
}

export function replaceOfferedAugment(manual: ManualGameState, index: number, selection: SelectedAugment | null): ManualGameState {
  const offeredAugments = [...manual.offeredAugments] as ManualGameState["offeredAugments"];
  offeredAugments[index] = selection;
  return { ...manual, offeredAugments };
}

export function liveRecommendationProblem(snapshot: LiveSnapshot | null, attached: boolean, now: number): string | null {
  if (!attached) return "Confirm the current Mayhem game, or disable Live Sync to use manual entry.";
  if (!isLiveFresh(snapshot, now)) return "Live data is stale. Retry, or disable Live Sync to use manual entry.";
  if (snapshot.inventory.some((entry) => !entry.known)) {
    return "Live inventory contains unknown items. Disable Live Sync and resolve the inventory manually before requesting a recommendation.";
  }
  return null;
}
