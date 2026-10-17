import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyGameState, recordOfferedAugment, type ManualGameState } from "../lib/game-state";
import { replaceOfferedAugment, type LiveSnapshot } from "../lib/live-state";
import { recommendationContext, RecommendationRequestLifecycle, type RecommendationKind } from "../lib/recommendation/request-lifecycle";

const manual = (): ManualGameState => ({ ...createEmptyGameState(), championId: 1, itemIds: [20],
  enemyChampionIds: [2], ownedAugments: [{ augmentId: 10, abilityContext: "Q" }],
  offeredAugments: [{ augmentId: 11, abilityContext: "W" }, { augmentId: 12 }, null], stats: { health: 2000 } });
const snapshot = (): LiveSnapshot => ({ observedAt: 100_000, gameTime: 100, gameMode: "ARAM", mapNumber: 12,
  sessionKey: "game", championId: 1, enemyChampionIds: [2, 3],
  inventory: [{ slot: 0, itemId: 20, count: 1, known: true }], stats: { health: 2000 }, warnings: [] });
const context = (state = manual(), live: LiveSnapshot | null = null, options: {
  game?: number; offer?: number; boundary?: number; status?: string; now?: number; candidate?: LiveSnapshot | null;
} = {}) => recommendationContext(state, { enabled: live !== null, snapshot: live, candidate: options.candidate ?? null,
  boundary: options.boundary ?? 0, status: options.status ?? "connected" }, options.game ?? 0, options.offer ?? 0, options.now ?? 100_001);
function submitted(kind: RecommendationKind = "item", live: LiveSnapshot | null = null) {
  const lifecycle = new RecommendationRequestLifecycle(), state = manual(), baseline = context(state, live);
  const token = lifecycle.start(kind, baseline)!;
  assert.equal(lifecycle.submit(token, baseline, state).status, "current");
  return { lifecycle, token, state };
}

test("synchronous duplicate protection is per kind; both requests can remain pending", () => {
  const lc = new RecommendationRequestLifecycle();
  const augment = lc.start("augment", context())!, item = lc.start("item", context())!;
  assert.ok(augment); assert.ok(item); assert.notEqual(augment.id, item.id);
  assert.equal(lc.start("augment", context()), null);
  assert.equal(lc.start("item", context()), null);
  lc.finish(augment);
  assert.ok(lc.start("augment", context()));
  assert.equal(lc.start("item", context()), null, "other cleanup cannot release item lock");
});

test("ordinary manual edits mark pending and retained advice outdated instead of invalid", () => {
  const original = manual();
  for (const changed of [
    { ...original, enemyChampionIds: [3] }, { ...original, itemIds: [21] },
    { ...original, stats: { health: 2100 } }, { ...original, stats: { health: 2000, critChance: 50 } },
    { ...original, ownedAugments: [{ augmentId: 10, abilityContext: "R" }] },
  ]) {
    for (const kind of ["augment", "item"] as const) {
      const { lifecycle, token } = submitted(kind);
      assert.equal(lifecycle.assess(token, context(changed)).status, "outdated");
      lifecycle.finish(token);
      assert.equal(lifecycle.assess(token, context(changed), true).status, "outdated");
      assert.equal(lifecycle.assess(token, context(original), true).status, "current");
    }
  }
});

test("rerolls, ability context changes and recording a pick invalidate augment decisions only", () => {
  const original = manual();
  for (const changed of [replaceOfferedAugment(original, 1, { augmentId: 13 }),
    replaceOfferedAugment(original, 0, { augmentId: 11, abilityContext: "E" }), recordOfferedAugment(original, 1)]) {
    const a = submitted("augment"), i = submitted("item");
    assert.equal(a.lifecycle.assess(a.token, context(changed, null, { offer: 1 })).reason, "offer-changed");
    assert.equal(a.lifecycle.assess(a.token, context(original, null, { offer: 2 })).status, "invalid", "restoring old IDs cannot revive a previous decision");
    assert.equal(i.lifecycle.assess(i.token, context(changed, null, { offer: 1 })).status, "outdated");
  }
});

test("poll noise, live stats and inventory slot rearrangements are incidental", () => {
  const { lifecycle, token } = submitted("item", snapshot());
  const poll = { ...snapshot(), observedAt: 102_000, gameTime: 102, enemyChampionIds: [3, 2],
    inventory: [{ ...snapshot().inventory[0], slot: 4 }], stats: { health: 2200, attackSpeed: 1.9 }, warnings: ["temporary"] };
  assert.equal(lifecycle.assess(token, context(manual(), poll, { now: 102_001 })).status, "current");
});

test("manually acquiring an offered candidate invalidates the augment decision and outdates item advice", () => {
  const a = submitted("augment"), i = submitted("item");
  const changed = { ...manual(), ownedAugments: [...manual().ownedAugments, { augmentId: 11 }] };
  assert.equal(a.lifecycle.assess(a.token, context(changed)).reason, "offer-changed");
  assert.equal(i.lifecycle.assess(i.token, context(changed)).status, "outdated");
});

test("disconnect during inference preserves advice as unverified; recovery restores freshness", () => {
  const { lifecycle, token } = submitted("item", snapshot());
  const stale = context(manual(), snapshot(), { status: "stale", now: 110_000 });
  assert.deepEqual(lifecycle.assess(token, stale), { status: "outdated", reason: "live-unverified", fields: ["liveAvailability"] });
  const recovered = { ...snapshot(), observedAt: 112_000, gameTime: 112 };
  assert.equal(lifecycle.assess(token, context(manual(), recovered, { now: 112_001 })).status, "current");
});

test("inventory purchase and enemy observation changes accept completed work as outdated", () => {
  const { lifecycle, token } = submitted("item", snapshot());
  for (const changed of [
    { ...snapshot(), inventory: [{ ...snapshot().inventory[0], itemId: 21 }] },
    { ...snapshot(), inventory: [] },
    { ...snapshot(), enemyChampionIds: [2, 4] },
  ]) assert.equal(lifecycle.assess(token, context(manual(), changed)).status, "outdated");
  assert.equal(lifecycle.assess(token, context(manual(), { ...snapshot(), inventory: [{ ...snapshot().inventory[0], known: false }] })).reason, "live-unverified");
});

test("match, champion, metadata and ambiguous attachment boundaries remain hard invalidations", () => {
  for (const kind of ["augment", "item"] as const) {
    const { lifecycle, token } = submitted(kind, snapshot());
    for (const changed of [{ ...snapshot(), championId: 4 }, { ...snapshot(), sessionKey: "another-game" },
      { ...snapshot(), mapNumber: 11 }, { ...snapshot(), gameMode: "KIWI" }]) {
      assert.equal(lifecycle.assess(token, context(manual(), changed)).reason, "game-boundary");
    }
    assert.equal(lifecycle.assess(token, context(manual(), snapshot(), { boundary: 1, candidate: snapshot() })).status, "invalid");
    assert.equal(lifecycle.assess(token, context(manual(), snapshot(), { boundary: 1 })).status, "invalid", "confirming cannot revive old work");
  }
});

test("preflight captures the exact submitted baseline after inventory refresh", () => {
  const lc = new RecommendationRequestLifecycle(), before = manual();
  const token = lc.start("item", context(before))!;
  const refreshed = { ...before, itemIds: [21], stats: { health: 2300 } };
  assert.equal(lc.submit(token, context(refreshed), refreshed).status, "current");
  assert.deepEqual(token.submittedState, refreshed);
  refreshed.itemIds.push(22);
  assert.deepEqual(token.submittedState!.itemIds, [21], "baseline does not share mutable state");
  assert.equal(lc.assess(token, context({ ...before, itemIds: [21], stats: { health: 2300 } })).status, "current");
});

test("New Game during preflight or inference never publishes old advice and preserves the pending lock", async () => {
  for (const phase of ["preflight", "inference"] as const) {
    const lc = new RecommendationRequestLifecycle(), token = lc.start("item", context())!;
    if (phase === "inference") lc.submit(token, context(), manual());
    let settle!: () => void;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    const completion = pending.then(() => phase === "preflight"
      ? lc.submit(token, context(manual(), null, { game: 1 }), manual())
      : lc.assess(token, context(manual(), null, { game: 1 })));
    assert.equal(lc.start("item", context(manual(), null, { game: 1 })), null);
    settle();
    assert.equal((await completion).reason, "game-boundary");
    assert.equal(token.baseline === undefined, phase === "preflight");
    lc.finish(token);
    assert.ok(lc.start("item", context(manual(), null, { game: 1 })));
  }
});

test("hard champion and offer boundaries cannot cross preflight unnoticed", () => {
  const lc = new RecommendationRequestLifecycle();
  const item = lc.start("item", context())!, augment = lc.start("augment", context())!;
  assert.equal(lc.submit(item, context({ ...manual(), championId: 4 }), manual()).status, "invalid");
  assert.equal(lc.submit(augment, context(manual(), null, { offer: 1 }), manual()).reason, "offer-changed");
  assert.equal(lc.assess(item, context(manual(), null, { game: 2 })).reason, "game-boundary", "restoring a previous champion cannot revive old work");
});

test("simultaneous requests finish independently in reverse order without replacing correlation", async () => {
  const lc = new RecommendationRequestLifecycle();
  const augment = lc.start("augment", context())!, item = lc.start("item", context())!;
  lc.submit(augment, context(), manual()); lc.submit(item, context(), manual());
  let finishAugment!: () => void, finishItem!: () => void;
  const augmentWork = new Promise<void>(resolve => { finishAugment = resolve; });
  const itemWork = new Promise<void>(resolve => { finishItem = resolve; });
  const completed: number[] = [];
  const settle = async (token: typeof item, work: Promise<void>) => {
    try { await work; assert.equal(lc.assess(token, context()).status, "current"); completed.push(token.id); }
    finally { lc.finish(token); }
  };
  const a = settle(augment, augmentWork), i = settle(item, itemWork);
  finishItem(); await i;
  assert.deepEqual(completed, [item.id]);
  assert.equal(lc.start("augment", context()), null);
  assert.ok(lc.start("item", context()));
  finishAugment(); await a;
  assert.deepEqual(completed, [item.id, augment.id]);
});

test("older responses and repeated cleanup cannot replace or unlock newer requests", () => {
  const { lifecycle: lc, token: old } = submitted();
  lc.finish(old);
  const newer = lc.start("item", context())!;
  lc.submit(newer, context(), manual());
  assert.equal(lc.assess(old, context()).reason, "superseded");
  assert.equal(lc.assess(old, context(), true).status, "current", "previous displayed advice remains available while updating");
  assert.equal(lc.finish(old), false);
  assert.equal(lc.start("item", context()), null);
  assert.equal(lc.assess(newer, context()).status, "current");
});

test("success, failure and hard invalidation release only the matching kind on settlement", async () => {
  for (const outcome of ["success", "failure", "invalid"] as const) {
    const lc = new RecommendationRequestLifecycle(), token = lc.start("item", context())!;
    lc.submit(token, context(), manual());
    const augment = lc.start("augment", context())!;
    let calls = 0;
    try {
      calls++;
      await Promise.resolve();
      assert.equal(lc.start("item", context()), null);
      if (outcome === "failure") throw Error("synthetic failure");
      assert.equal(lc.assess(token, context(manual(), null, { game: outcome === "invalid" ? 1 : 0 })).status,
        outcome === "invalid" ? "invalid" : "current");
    } catch { assert.equal(outcome, "failure"); }
    finally { lc.finish(token); }
    assert.equal(calls, 1);
    assert.ok(lc.start("item", context()));
    assert.equal(lc.start("augment", context()), null);
    lc.finish(augment);
  }
});
