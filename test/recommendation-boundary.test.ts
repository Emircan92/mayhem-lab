import assert from "node:assert/strict";
import test from "node:test";

import type { Augment, Champion, Item } from "../lib/catalog";
import { createEmptyGameState, type ManualGameState } from "../lib/game-state";
import { buildRecommendationSnapshot, type RecommendationCatalog } from "../lib/preprocess-game-state";
import { buildRecommendationPrompt } from "../lib/recommendation/build-prompt";
import {
  buildCompletedItemCandidates,
  itemCandidateExclusion,
} from "../lib/recommendation/candidate-policy";
import { validateRecommendationResponse } from "../lib/recommendation/validate-response";
import { FakeRecommendationProvider } from "../lib/recommendation/provider";
import { runRecommendation } from "../lib/recommendation/service";
import {
  createAugmentRecommendationRequest,
  createItemRecommendationRequest,
  type RecommendationRequest,
} from "../lib/recommendation-contract";

const champion: Champion = { id: 1, key: "Hero", name: "Hero", title: "the Test", tags: ["Mage"] };
const contextualAugment: Augment = {
  id: 10,
  internalName: "Contextual",
  name: "Contextual Augment",
  rarity: "gold",
  description: "Your affected ability gains haste.",
  descriptionStatus: "contextual-normalized",
  descriptionQuality: "contextual-usable",
  requiresAbilityContext: true,
  contextualTokens: ["@SpellName@"],
  resolvedTokens: [],
  unresolvedTokens: [],
  descriptionSource: { type: "communitydragon-string" },
};
const secondAugment: Augment = { ...contextualAugment, id: 11, internalName: "Second", name: "Second Augment", requiresAbilityContext: false };

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: 20,
    name: "Finished Blade",
    description: "Gain Attack Damage.",
    plainText: "Damage",
    purchasable: true,
    gold: { base: 1000, total: 3000, sell: 2100 },
    tags: ["Damage"],
    stats: { FlatPhysicalDamageMod: 70 },
    from: [1001],
    into: [],
    mapIds: [12],
    ...overrides,
  };
}

const items = [item()];
const catalog: RecommendationCatalog = {
  champions: [champion],
  augments: [contextualAugment, secondAugment],
  items,
};
const metadata = { patch: "16.19.1", generatedAt: "2026-09-28T00:00:00.000Z" };

function state(overrides: Partial<ManualGameState> = {}): ManualGameState {
  return { ...createEmptyGameState(), championId: 1, ...overrides };
}

function validResponse(kind: "augment" | "item", id: number, name: string) {
  return {
    schemaVersion: 1,
    kind,
    primary: { id, name, reason: "Grounded reason." },
    alternatives: [],
    buildDirection: null,
    warnings: [],
    confidence: "high",
  };
}

function augmentRequest(): RecommendationRequest {
  const snapshot = buildRecommendationSnapshot(
    state({ offeredAugments: [{ augmentId: 10 }, null, { augmentId: 11 }] }),
    catalog,
    metadata,
  );
  return createAugmentRecommendationRequest(snapshot);
}

function itemRequest(): RecommendationRequest {
  const snapshot = buildRecommendationSnapshot(state(), catalog, metadata);
  return createItemRecommendationRequest(snapshot, buildCompletedItemCandidates(items));
}

test("augment responses cannot select outside the offered candidates", () => {
  const result = validateRecommendationResponse(validResponse("augment", 999, "Invented"), augmentRequest());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.issues.join(" "), /not in the supplied candidate set/);
});

test("item responses cannot select outside the supplied item candidates", () => {
  const result = validateRecommendationResponse(validResponse("item", 999, "Invented"), itemRequest());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.issues.join(" "), /not in the supplied candidate set/);
});

test("primary and alternatives cannot repeat an ID", () => {
  const raw = {
    ...validResponse("augment", 10, "Contextual Augment"),
    alternatives: [{ id: 10, name: "Contextual Augment", reason: "Duplicate.", preferWhen: null }],
  };
  const result = validateRecommendationResponse(raw, augmentRequest());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.issues.join(" "), /must be unique/);
});

test("malformed response fields are rejected", () => {
  const request = itemRequest();
  const malformed = [
    { ...validResponse("item", 20, "Finished Blade"), primary: { name: "Finished Blade", reason: "Reason" } },
    { ...validResponse("item", 20, "Finished Blade"), primary: { id: 20, name: "Finished Blade", reason: "" } },
    { ...validResponse("item", 20, "Finished Blade"), confidence: "certain" },
  ];
  for (const raw of malformed) assert.equal(validateRecommendationResponse(raw, request).ok, false);
});

test("crit saturation constraint is present in the constructed reasoning request", () => {
  const snapshot = buildRecommendationSnapshot(
    state({ stats: { critChance: 100 }, offeredAugments: [{ augmentId: 11 }, null, null] }),
    catalog,
    metadata,
  );
  const prompt = buildRecommendationPrompt(createAugmentRecommendationRequest(snapshot));
  assert.match(prompt.input, /additional-critical-strike-chance-has-no-intrinsic-value/);
  assert.match(prompt.instructions, /additional value in that stat has no intrinsic benefit/);
});

test("missing ability context warning is present in the constructed request", () => {
  const request = augmentRequest();
  const prompt = buildRecommendationPrompt(request);
  assert.match(prompt.input, /augment-context-missing/);
  assert.match(prompt.input, /recommendation confidence may be reduced/);
});

test("candidate policy excludes only clear metadata-backed non-candidates", () => {
  const component = item({ id: 21, name: "Component", into: [20] });
  const nonPurchasable = item({ id: 22, name: "Transformed", purchasable: false });
  const wrongMap = item({ id: 23, name: "Other Map", mapIds: [11] });
  const consumable = item({ id: 24, name: "Potion", tags: ["Consumable"] });
  const internal = item({ id: 25, name: "Placeholder Item" });

  assert.equal(itemCandidateExclusion(component), "component");
  assert.equal(itemCandidateExclusion(nonPurchasable), "not-purchasable");
  assert.equal(itemCandidateExclusion(wrongMap), "not-available-on-aram");
  assert.equal(itemCandidateExclusion(consumable), "non-item-category");
  assert.equal(itemCandidateExclusion(internal), "unnamed-or-internal");
  assert.deepEqual(
    buildCompletedItemCandidates([items[0], component, nonPurchasable, wrongMap, consumable, internal]).map((entry) => entry.id),
    [20],
  );
});

test("the deterministic fake exercises the same prompt and validation boundary without a model call", async () => {
  const run = await runRecommendation(augmentRequest(), new FakeRecommendationProvider());
  assert.equal(run.provider.provider, "fake");
  assert.equal(run.recommendation.primary.id, 10);
  assert.match(run.recommendation.primary.reason, /not strategic advice/);
});

