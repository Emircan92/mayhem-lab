import assert from "node:assert/strict";
import test from "node:test";
import snapshot from "../data/generated/16.19.1/items.json";
import type { Item } from "../lib/catalog";
import { buildCompletedItemCandidates, itemCandidateExclusion } from "../lib/recommendation/candidate-policy";

test("pinned KIWI catalog excludes rewards, other-mode variants, and conditional purchases", () => {
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  for (const [id, classification] of [
    [994403, "quest-or-script-gated"], [773128, "other-mode"],
    [3084, "ordinary-shop"], [223084, "other-mode"], [3085, "conditional"],
    [3087, "conditional"], [6620, "conditional"], [6621, "conditional"],
  ] as const) {
    const item = byId.get(id)!;
    assert.equal(item.eligibility.classification, classification, `${id} classification`);
    assert.equal(itemCandidateExclusion(item) === null, id === 3084, `${id} candidate eligibility`);
  }
  assert.equal(snapshot.items.length, 866, "inventory catalog remains complete");
  const candidates = buildCompletedItemCandidates(snapshot.items);
  assert.equal(candidates.length, 105, "pinned ordinary completed-item count");
  for (const candidate of candidates) assert.equal(byId.get(candidate.id)!.eligibility.classification, "ordinary-shop");
  assert.equal(itemCandidateExclusion({ ...byId.get(3084)!, eligibility: undefined }), "not-established-KIWI-shop-purchase");
  assert.equal(itemCandidateExclusion({ ...byId.get(3084)!, into: [999] }), "component");
});

test("the completed-boot exception adds exactly seven ordinary recipes without prioritizing them", () => {
  const candidates = buildCompletedItemCandidates(snapshot.items);
  const previousIds = new Set(snapshot.items.filter((item) => item.into.length === 0
    && itemCandidateExclusion(item) === null).map((item) => item.id));
  assert.equal(previousIds.size, 98);
  assert.deepEqual(candidates.filter((item) => !previousIds.has(item.id)).map((item) => item.id).sort((a, b) => a - b),
    [3006, 3008, 3009, 3020, 3047, 3111, 3158]);
  assert.deepEqual(candidates, [...candidates].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id));
  assert.deepEqual(snapshot.items.filter((item) => item.tags.some((tag) => tag === "Boots")
    && itemCandidateExclusion(item) === null).map((item) => item.id),
    [3006, 3008, 3009, 3020, 3047, 3111, 3158]);
  // Basic, magical, mobility, transformed, later-upgrade and other-mode variants stay excluded.
  for (const id of [1001, 2422, 3005, 3010, 3013, 3117, 3168, 3170, 3171, 3173, 3174, 3175, 3176,
    223006, 771001, 773006, 773009, 773020, 773047, 773111, 773117, 773158]) {
    assert.notEqual(itemCandidateExclusion(snapshot.items.find((item) => item.id === id)!), null, `${id} excluded`);
  }
});

test("boot recipes bypass only the into filter, retaining every other constraint", () => {
  const boots: Item = snapshot.items.find((item) => item.id === 3006)!;
  for (const [update, reason] of [
    [{ tags: ["AttackSpeed"] }, "component"],
    [{ from: [1042] }, "component"],
    [{ name: "" }, "unnamed-or-internal"],
    [{ name: "Internal only boots" }, "unnamed-or-internal"],
    [{ purchasable: false }, "not-purchasable"],
    [{ mapIds: [11] }, "not-available-on-aram"],
    [{ tags: ["Boots", "Consumable"] }, "non-item-category"],
    [{ gold: { ...boots.gold, total: 0 } }, "no-positive-price"],
    [{ eligibility: undefined }, "not-established-KIWI-shop-purchase"],
    ...["other-mode", "conditional", "quest-or-script-gated", "unresolved", "legacy-or-inaccessible"]
      .map((classification) => [{ eligibility: { ...boots.eligibility!, classification } }, "not-established-KIWI-shop-purchase"] as const),
  ] as Array<readonly [Partial<Item>, string]>) {
    assert.equal(itemCandidateExclusion({ ...boots, ...update }), reason);
  }
});
