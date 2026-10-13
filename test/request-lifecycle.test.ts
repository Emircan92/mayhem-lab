import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyGameState, recordOfferedAugment, type ManualGameState } from "../lib/game-state";
import { replaceOfferedAugment, type LiveSnapshot } from "../lib/live-state";
import { recommendationStateKey, RecommendationRequestLifecycle } from "../lib/recommendation/request-lifecycle";

const manual = (): ManualGameState => ({ ...createEmptyGameState(), championId: 1, itemIds: [20],
  enemyChampionIds: [2], ownedAugments: [{ augmentId: 10, abilityContext: "Q" }],
  offeredAugments: [{ augmentId: 11, abilityContext: "W" }, { augmentId: 12 }, null], stats: { health: 2000 } });
const snapshot = (): LiveSnapshot => ({ observedAt: 100_000, gameTime: 100, gameMode: "ARAM", mapNumber: 12,
  sessionKey: "game", championId: 1, enemyChampionIds: [2, 3],
  inventory: [{ slot: 0, itemId: 20, count: 1, known: true }], stats: { health: 2000 }, warnings: [] });
const key = (state = manual(), live: LiveSnapshot | null = null, enabled = false, candidate: LiveSnapshot | null = null) =>
  recommendationStateKey(state, { enabled, snapshot: live, candidate });

test("synchronous lock rejects duplicate and cross-kind submissions before a render or await", () => {
  const lifecycle = new RecommendationRequestLifecycle();
  const token = lifecycle.start(key())!;
  assert.equal(lifecycle.start(key()), null);
  assert.equal(lifecycle.start(key({ ...manual(), itemIds: [21] })), null);
  assert.equal(lifecycle.isCurrent(token, key()), true);
  lifecycle.finish(token);
  assert.notEqual(lifecycle.start(key()), null);
});

test("all manual material edits invalidate both pending and finished results, even if reverted", () => {
  const original = manual();
  for (const changed of [
    { ...original, championId: 4 }, { ...original, enemyChampionIds: [3] }, { ...original, itemIds: [21] },
    { ...original, stats: { health: 2100 } }, { ...original, stats: { health: 2000, critChance: 50 } },
    { ...original, ownedAugments: [{ augmentId: 10, abilityContext: "R" }] },
    replaceOfferedAugment(original, 1, { augmentId: 13 }),
    replaceOfferedAugment(original, 0, { augmentId: 11, abilityContext: "E" }),
    recordOfferedAugment(original, 1),
  ]) {
    const lifecycle = new RecommendationRequestLifecycle();
    const token = lifecycle.start(key(original))!;
    assert.equal(lifecycle.observe(key(changed)), true);
    assert.equal(lifecycle.isCurrent(token, key(changed)), false);
    assert.equal(lifecycle.isCurrent(token, key(original)), false, "reverting cannot revive the response");
    lifecycle.finish(token);
    assert.equal(lifecycle.observe(key(changed)), true, "finished results also become stale");
  }
});

test("live polls and transient stats leave results current; structural sync and attachment changes invalidate", () => {
  const live = snapshot();
  const initial = key(manual(), live, true);
  const lifecycle = new RecommendationRequestLifecycle();
  const token = lifecycle.start(initial)!;
  const poll = { ...live, observedAt: 102_000, gameTime: 102, stats: { health: 2200, attackSpeed: 1.9 }, warnings: ["temporary"] };
  assert.equal(key(manual(), poll, true), initial);
  assert.equal(lifecycle.observe(key(manual(), poll, true)), false);
  assert.equal(lifecycle.isCurrent(token, key(manual(), poll, true)), true);
  assert.equal(key(manual(), { ...poll, enemyChampionIds: [3, 2] }, true), initial, "roster ordering is immaterial");
  for (const changed of [
    { ...live, inventory: [] },
    { ...live, inventory: [{ ...live.inventory[0], itemId: 21 }] },
    { ...live, inventory: [{ ...live.inventory[0], count: 2 }] },
    { ...live, inventory: [{ ...live.inventory[0], known: false }] },
    { ...live, championId: 4 }, { ...live, enemyChampionIds: [5] }, { ...live, sessionKey: "new-game" },
    { ...live, mapNumber: 11 }, { ...live, gameMode: "KIWI" },
  ]) assert.notEqual(key(manual(), changed, true), initial);
  assert.notEqual(key(manual(), live, false), initial);
  assert.notEqual(key(manual(), live, true, poll), initial);
  assert.equal(key(manual(), live, true, poll), key(manual(), live, true, { ...poll, observedAt: 104_000 }));
  assert.equal(lifecycle.isCurrent(token, key(manual(), { ...live, inventory: [] }, true)), false);
});

test("response validation catches a material sync update before its invalidation effect runs", () => {
  const lifecycle = new RecommendationRequestLifecycle();
  const token = lifecycle.start(key(manual(), snapshot(), true))!;
  assert.equal(lifecycle.isCurrent(token, key(manual(), { ...snapshot(), inventory: [] }, true)), false);
});

test("success, failure, stale completion and reset release the guard only when pending work settles", async () => {
  for (const outcome of ["success", "failure", "stale", "reset"] as const) {
    const lifecycle = new RecommendationRequestLifecycle();
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    let paidCalls = 0;
    let published = false;
    async function submit() {
      const token = lifecycle.start(key());
      if (!token) return;
      try {
        paidCalls++;
        await pending;
        if (outcome === "failure") throw new Error("provider failed");
        published = lifecycle.isCurrent(token, key());
      } catch {
        // Production displays the failure only if the request is still current.
      } finally {
        lifecycle.finish(token);
      }
    }
    const task = submit();
    await submit();
    if (outcome === "stale") lifecycle.observe(key({ ...manual(), itemIds: [21] }));
    if (outcome === "reset") lifecycle.reset();
    await submit();
    assert.equal(paidCalls, 1, `${outcome}: only one paid call while pending`);
    settle();
    await task;
    assert.equal(published, outcome === "success");
    const next = lifecycle.start(key())!;
    assert.ok(next, `${outcome}: retry allowed after settlement`);
    lifecycle.finish(next);
    lifecycle.finish(next); // Repeated cleanup cannot release a later request.
    const later = lifecycle.start(key())!;
    lifecycle.finish(next);
    assert.equal(lifecycle.start(key()), null);
    lifecycle.finish(later);
  }
});
