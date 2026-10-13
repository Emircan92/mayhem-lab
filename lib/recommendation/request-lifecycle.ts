import type { ManualGameState } from "../game-state";
import type { LiveSession } from "../live-state";

// Poll timestamps, game time, warnings, freshness and live stats are deliberately
// absent. Manual stat edits and structural live changes are material.
export function recommendationStateKey(manual: ManualGameState, live: LiveSession & { enabled: boolean }): string {
  const snapshot = live.enabled ? live.snapshot : null;
  return JSON.stringify({
    manual: { ...manual, stats: Object.entries(manual.stats).sort(([a], [b]) => a.localeCompare(b)) },
    live: {
      enabled: live.enabled,
      pendingAttachment: live.enabled && live.candidate !== null,
      snapshot: snapshot && {
        sessionKey: snapshot.sessionKey,
        mapNumber: snapshot.mapNumber,
        gameMode: snapshot.gameMode,
        championId: snapshot.championId,
        enemyChampionIds: [...snapshot.enemyChampionIds].sort((a, b) => a - b),
        inventory: [...snapshot.inventory].sort((a, b) => a.slot - b.slot)
          .map(({ slot, itemId, count, known }) => ({ slot, itemId, count, known })),
      },
    },
  });
}

type RequestToken = Readonly<{ revision: number }>;

export class RecommendationRequestLifecycle {
  private key: string | null = null;
  private revision = 0;
  private active: RequestToken | null = null;

  observe(key: string): boolean {
    if (this.key === key) return false;
    const changed = this.key !== null;
    this.key = key;
    if (changed) this.revision++;
    return changed;
  }

  start(key: string): RequestToken | null {
    if (this.active) return null;
    this.observe(key);
    this.active = { revision: this.revision };
    return this.active;
  }

  isCurrent(token: RequestToken, key: string): boolean {
    this.observe(key);
    return this.active === token && token.revision === this.revision;
  }

  reset(): void {
    this.revision++;
    // A reset invalidates the result; it cannot cancel already-paid work.
    // Keep the lock until that request's finally block runs.
  }

  finish(token: RequestToken): void {
    if (this.active === token) this.active = null;
  }
}
