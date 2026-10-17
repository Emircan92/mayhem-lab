import type { ManualGameState } from "../game-state";
import { isLiveFresh, type LiveSession } from "../live-state";

export type RecommendationKind = "augment" | "item";
export type FreshnessReason = "game-boundary" | "offer-changed" | "superseded" | "not-submitted" | "state-changed" | "live-unverified";
export type FreshnessField = "game" | "items" | "enemies" | "ownedAugments" | "offeredAugments" | "stats" | "liveAvailability";
export type Freshness = { status: "current" | "outdated" | "invalid"; reason?: FreshnessReason; fields: FreshnessField[] };
export type RecommendationContext = {
  gameKey: string;
  decisionKey: string;
  verified: boolean;
  fields: Record<string, string>;
};
type LiveView = LiveSession & { enabled: boolean; boundary: number; status: string };
const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const statsKey = (stats: ManualGameState["stats"]) => JSON.stringify(Object.entries(stats).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
export const augmentDecisionKey = (state: ManualGameState) => JSON.stringify([
  state.offeredAugments,
  sorted(state.ownedAugments.filter(owned => state.offeredAugments.some(offer => offer?.augmentId === owned.augmentId)).map(a => a.augmentId)),
]);

// Use last confirmed observations across transport failures. The editor's
// temporary manual fallback is not evidence of a different game.
export function recommendationContext(manual: ManualGameState, live: LiveView, gameEpoch: number, offerEpoch: number, now: number): RecommendationContext {
  const s = live.enabled ? live.snapshot : null;
  return {
    gameKey: JSON.stringify([gameEpoch, live.boundary, live.enabled, s?.sessionKey, s?.mapNumber, s?.gameMode, s?.championId ?? manual.championId]),
    decisionKey: JSON.stringify([offerEpoch, augmentDecisionKey(manual)]),
    verified: !live.enabled || (!!s && !live.candidate && live.status === "connected" && isLiveFresh(s, now) && s.inventory.every(i => i.known)),
    fields: {
      items: JSON.stringify(s ? s.inventory.map(({ itemId, count, known }) => [itemId, count, known]).sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]) || Number(a[2]) - Number(b[2])) : sorted(manual.itemIds)),
      enemies: JSON.stringify(sorted(s?.enemyChampionIds ?? manual.enemyChampionIds)),
      ownedAugments: JSON.stringify([...manual.ownedAugments].sort((a, b) => a.augmentId - b.augmentId)),
      offeredAugments: JSON.stringify(manual.offeredAugments),
      // Live stat fluctuations are incidental; explicit manual stats/crit edits matter.
      stats: statsKey(s ? { critChance: manual.stats.critChance } : manual.stats),
    },
  };
}

export type RequestToken = {
  readonly id: number;
  readonly kind: RecommendationKind;
  readonly acquired: RecommendationContext;
  baseline?: RecommendationContext;
  submittedState?: ManualGameState;
};

export class RecommendationRequestLifecycle {
  private sequence = 0;
  private active: Partial<Record<RecommendationKind, RequestToken>> = {};
  private latest: Partial<Record<RecommendationKind, number>> = {};

  start(kind: RecommendationKind, context: RecommendationContext): RequestToken | null {
    if (this.active[kind]) return null;
    const token: RequestToken = { id: ++this.sequence, kind, acquired: context };
    this.active[kind] = token;
    this.latest[kind] = token.id;
    return token;
  }

  preflight(token: RequestToken, context: RecommendationContext, retained = false): Freshness {
    if (!retained && this.latest[token.kind] !== token.id) return { status: "invalid", reason: "superseded", fields: [] };
    if (token.acquired.gameKey !== context.gameKey) return { status: "invalid", reason: "game-boundary", fields: ["game"] };
    if (token.kind === "augment" && token.acquired.decisionKey !== context.decisionKey) return { status: "invalid", reason: "offer-changed", fields: ["offeredAugments"] };
    return { status: "current", fields: [] };
  }

  submit(token: RequestToken, context: RecommendationContext, state: ManualGameState): Freshness {
    const check = this.preflight(token, context);
    if (check.status !== "invalid") {
      token.baseline = structuredClone(context);
      token.submittedState = structuredClone(state);
    }
    return check;
  }

  assess(token: RequestToken, context: RecommendationContext, retained = false): Freshness {
    const check = this.preflight(token, context, retained);
    if (check.status === "invalid") return check;
    if (!token.baseline) return { status: "invalid", reason: "not-submitted", fields: [] };
    const fields = Object.keys(context.fields).filter(field => context.fields[field] !== token.baseline!.fields[field]) as FreshnessField[];
    if (!context.verified) fields.push("liveAvailability");
    return fields.length ? { status: "outdated", reason: context.verified ? "state-changed" : "live-unverified", fields }
      : { status: "current", fields: [] };
  }

  finish(token: RequestToken): boolean {
    if (this.active[token.kind] !== token) return false;
    delete this.active[token.kind];
    return true;
  }
}
