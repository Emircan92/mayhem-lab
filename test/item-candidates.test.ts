import assert from "node:assert/strict";
import test from "node:test";
import snapshot from "../data/generated/16.19.1/items.json";
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
  assert.equal(candidates.length, 98, "pinned ordinary completed-item count");
  for (const candidate of candidates) assert.equal(byId.get(candidate.id)!.eligibility.classification, "ordinary-shop");
  assert.equal(itemCandidateExclusion({ ...byId.get(3084)!, eligibility: undefined }), "not-established-KIWI-shop-purchase");
  assert.equal(itemCandidateExclusion({ ...byId.get(3084)!, into: [999] }), "component");
});
