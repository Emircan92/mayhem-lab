import assert from "node:assert/strict";
import test from "node:test";
import { deriveItemEligibility, compareItemMembership } from "../scripts/item-eligibility.mjs";

function fixture() {
  return {
    items: [{ id: 3084 }, { id: 223084 }, { id: 994403 }, { id: 773128 }, { id: 3085 }, { id: 999 }],
    mapData: {
      "Maps/Shipping/Map12/Modes/KIWI": { __type: "GameModeMapData", itemLists: ["{new-list-reference}"] },
      "{new-list-reference}": { __type: "GameModeItemList", mItems: ["{new-heartsteel-reference}", "Items/994403", "Items/3085"] },
      "Maps/Shipping/Map12/Modes/KIWI_JADE": { __type: "GameModeMapData", itemLists: ["OtherList"] },
      OtherList: { __type: "GameModeItemList", mItems: ["Items/223084", "Items/773128"] },
    },
    rawItems: Object.fromEntries([
      ["{new-heartsteel-reference}", 3084, {}], ["Items/223084", 223084, {}],
      ["Items/994403", 994403, { mRequiredSpellName: "CanPurchase" }],
      ["Items/773128", 773128, {}], ["Items/3085", 3085, { mRequiredPurchaseIdentities: ["Ranged"] }],
    ].map(([reference, itemID, extra]) => [reference, {
      __type: "ItemData", itemID, mItemDataAvailability: { __type: "ItemDataAvailability", mInStore: true }, ...extra,
    }])),
  };
}

test("dynamic mode/list/item references distinguish shop purchases, variants, and script rewards", () => {
  const result = deriveItemEligibility(fixture());
  assert.deepEqual(result.diagnostics.errors, []);
  assert.deepEqual(result.items.map((item) => item.eligibility.classification), [
    "ordinary-shop", "other-mode", "quest-or-script-gated", "other-mode", "conditional", "unresolved",
  ]);
  assert.equal(result.items[0].eligibility.rawItemReference, "{new-heartsteel-reference}");
  assert.equal(result.items[0].eligibility.memberships[0].listReference, "{new-list-reference}");
  assert.deepEqual(result.items[2].eligibility.purchaseRestrictions, { mRequiredSpellName: "CanPurchase" });
});

test("conditions, missing/hidden stores, opaque fields, and changed condition schemas fail closed", () => {
  for (const extra of [
    { mRequiredLevel: 9 }, { RestrictedBuffName: "HeroPassive" }, { mRequiredChampion: "Hero" },
    { mRequiredBuffCurrencyName: "Quest", mRequiredBuffCurrencyCost: 1 }, { requiredItemLinks: ["Items/1"] },
  ]) {
    const input = fixture();
    Object.assign(input.rawItems["{new-heartsteel-reference}"], extra);
    assert.equal(deriveItemEligibility(input).items[0].eligibility.classification, "conditional");
  }
  for (const [extra, expected] of [
    [{ mItemDataAvailability: undefined }, "unresolved"],
    [{ mItemDataAvailability: { __type: "ItemDataAvailability", mInStore: true, mHidefromAll: true } }, "legacy-or-inaccessible"],
    [{ mItemDataAvailability: { __type: "ItemDataAvailability", mInStore: "true" } }, "unresolved"],
    [{ mRequiredLevel: "9" }, "unresolved"], [{ mNewPurchaseRule: true }, "unresolved"],
    [{ "{unknown-field}": [] }, "unresolved"],
  ]) {
    const input = fixture();
    Object.assign(input.rawItems["{new-heartsteel-reference}"], extra);
    const result = deriveItemEligibility(input);
    assert.equal(result.items[0].eligibility.classification, expected);
    if (expected === "unresolved") assert.ok(result.diagnostics.schemaChanges.some((item) => item.id === 3084));
  }
});

test("missing references and changed list schemas prevent refresh publication", () => {
  for (const mutate of [
    (input) => delete input.rawItems["{new-heartsteel-reference}"],
    (input) => input.mapData["{new-list-reference}"].mItems = "changed",
    (input) => input.mapData["{new-list-reference}"].purchaseRule = "unknown",
    (input) => input.mapData["Maps/Shipping/Map12/Modes/KIWI"].newModeRule = true,
    (input) => delete input.mapData["Maps/Shipping/Map12/Modes/KIWI"],
  ]) {
    const input = fixture(); mutate(input);
    assert.ok(deriveItemEligibility(input).diagnostics.errors.length > 0);
  }
});

test("patch comparison reports mode membership and classification changes", () => {
  const before = deriveItemEligibility(fixture());
  const input = fixture();
  input.mapData["{new-list-reference}"].mItems.pop();
  input.rawItems["{new-heartsteel-reference}"].mRequiredLevel = 10;
  const result = compareItemMembership({ items: before.items, eligibilityDiagnostics: before.diagnostics }, deriveItemEligibility(input), "old");
  assert.deepEqual(result.modes.KIWI.removed, [3085]);
  assert.ok(result.classificationChanges.some((item) => item.id === 3084 && item.after === "conditional"));
  assert.equal(compareItemMembership(null, before, null).status, "no-eligibility-baseline");
});
