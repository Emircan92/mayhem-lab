import test from "node:test";
import assert from "node:assert/strict";

import type { Augment, Champion, Item } from "../lib/catalog";
import {
  createEmptyGameState,
  parseStoredGameState,
  serializeGameState,
  type CatalogIds,
  type ManualGameState,
} from "../lib/game-state";
import {
  buildRecommendationSnapshot,
  SnapshotNormalizationError,
  type RecommendationCatalog,
} from "../lib/preprocess-game-state";
import { createAugmentRecommendationRequest } from "../lib/recommendation-contract";

const champions: Champion[] = [
  { id: 1, key: "Hero", name: "Hero", title: "the Test", tags: ["Marksman"] },
  { id: 2, key: "Enemy", name: "Enemy", title: "the Rival", tags: ["Tank", "Fighter"] },
];

function augment(overrides: Partial<Augment> = {}): Augment {
  return {
    id: 10,
    internalName: "ContextualAugment",
    name: "Contextual Augment",
    rarity: "gold",
    description: "Your affected ability gains Ability Haste.",
    descriptionStatus: "contextual-normalized",
    descriptionQuality: "contextual-usable",
    requiresAbilityContext: true,
    contextualTokens: ["@SpellName@"],
    resolvedTokens: [],
    unresolvedTokens: [],
    descriptionSource: { type: "communitydragon-string", key: "test" },
    ...overrides,
  };
}

const items: Item[] = [
  {
    id: 20,
    name: "Test Blade",
    description: "Gain Attack Damage.",
    plainText: "Damage",
    purchasable: true,
    gold: { base: 1000, total: 3000, sell: 2100 },
    tags: ["Damage"],
    stats: { FlatPhysicalDamageMod: 70 },
    from: [],
    into: [],
    mapIds: [11],
  },
];

const catalog: RecommendationCatalog = {
  champions,
  augments: [
    augment(),
    augment({
      id: 11,
      internalName: "MissingDetailAugment",
      name: "Missing Detail Augment",
      description: "Gain @Amount@ power.",
      descriptionStatus: "unresolved-tokens",
      descriptionQuality: "usable-with-missing-detail",
      requiresAbilityContext: false,
      contextualTokens: [],
      unresolvedTokens: ["@Amount@"],
    }),
  ],
  items,
};

const metadata = { patch: "16.19.1", generatedAt: "2026-09-28T00:00:00.000Z" };

function state(overrides: Partial<ManualGameState> = {}): ManualGameState {
  return {
    ...createEmptyGameState(),
    championId: 1,
    ...overrides,
  };
}

test("100 percent crit normalizes to a ratio and emits only the narrow saturation constraint", () => {
  const snapshot = buildRecommendationSnapshot(state({ stats: { critChance: 100 } }), catalog, metadata);

  assert.deepEqual(snapshot.stats.critChance, {
    value: 1,
    unit: "ratio",
    reportedPercent: 100,
  });
  assert.deepEqual(
    snapshot.facts.find((fact) => fact.kind === "stat-cap"),
    {
      kind: "stat-cap",
      stat: "critChance",
      value: 1,
      cap: 1,
      unit: "ratio",
      constraint: "additional-critical-strike-chance-has-no-intrinsic-value",
    },
  );
  assert.equal(JSON.stringify(snapshot).includes("forbidden"), false);
});

test("a supplied contextual ability becomes a fact without a missing-context warning", () => {
  const snapshot = buildRecommendationSnapshot(
    state({ ownedAugments: [{ augmentId: 10, abilityContext: "Q" }] }),
    catalog,
    metadata,
  );

  assert.equal(snapshot.ownedAugments[0].abilityContext, "Q");
  assert.deepEqual(
    snapshot.facts.find((fact) => fact.kind === "augment-context"),
    {
      kind: "augment-context",
      augmentId: 10,
      augmentName: "Contextual Augment",
      abilityContext: "Q",
      selection: "owned",
    },
  );
  assert.equal(snapshot.warnings.some((warning) => warning.kind === "augment-context-missing"), false);
});

test("an omitted contextual ability emits a confidence warning without guessing", () => {
  const snapshot = buildRecommendationSnapshot(
    state({ offeredAugments: [{ augmentId: 10 }, null, null] }),
    catalog,
    metadata,
  );

  assert.equal(snapshot.offeredAugments[0]?.abilityContext, undefined);
  assert.deepEqual(
    snapshot.warnings.find((warning) => warning.kind === "augment-context-missing"),
    {
      kind: "augment-context-missing",
      augmentId: 10,
      augmentName: "Contextual Augment",
      message: "The affected ability was not supplied; recommendation confidence may be reduced.",
      selection: "offered",
      offeredSlot: 1,
    },
  );
});

test("a usable description with missing details remains selected and emits data-quality metadata", () => {
  const snapshot = buildRecommendationSnapshot(
    state({ ownedAugments: [{ augmentId: 11 }] }),
    catalog,
    metadata,
  );

  assert.equal(snapshot.ownedAugments[0].id, 11);
  assert.equal(snapshot.ownedAugments[0].descriptionQuality, "usable-with-missing-detail");
  assert.equal(
    snapshot.warnings.some((warning) => warning.kind === "augment-description-missing-detail"),
    true,
  );
  assert.deepEqual(snapshot.dataQuality.missingDetailAugmentIds, [11]);
  assert.deepEqual(snapshot.dataQuality.unresolvedTokens, [{ augmentId: 11, tokens: ["@Amount@"] }]);
});

test("restored and freshly entered equivalent state produce the same snapshot", () => {
  const fresh = state({
    ownedAugments: [{ augmentId: 10, abilityContext: "Passive" }],
    itemIds: [20, 20],
    enemyChampionIds: [2],
    stats: { attackSpeed: 1.75, abilityHaste: 60 },
  });
  const ids: CatalogIds = {
    championIds: new Set(champions.map((entry) => entry.id)),
    augmentIds: new Set(catalog.augments.map((entry) => entry.id)),
    itemIds: new Set(items.map((entry) => entry.id)),
  };
  const restored = parseStoredGameState(serializeGameState(fresh, metadata.patch), ids);

  assert.deepEqual(
    buildRecommendationSnapshot(restored, catalog, metadata),
    buildRecommendationSnapshot(fresh, catalog, metadata),
  );
});

test("unknown catalog references fail clearly rather than inventing an entity", () => {
  assert.throws(
    () => buildRecommendationSnapshot(state({ itemIds: [999] }), catalog, metadata),
    (error) =>
      error instanceof SnapshotNormalizationError && error.message === "Unknown item ID 999.",
  );
});

test("inventory and enemy summaries remain descriptive and source-backed", () => {
  const snapshot = buildRecommendationSnapshot(
    state({ itemIds: [20, 20], enemyChampionIds: [2] }),
    catalog,
    metadata,
  );

  assert.deepEqual(snapshot.facts.filter((fact) => fact.kind === "item-owned"), [
    { kind: "item-owned", itemId: 20, itemName: "Test Blade", count: 2 },
  ]);
  assert.deepEqual(snapshot.facts.find((fact) => fact.kind === "inventory-summary"), {
    kind: "inventory-summary",
    slotCount: 2,
    slotCapacity: 6,
    duplicateItemIds: [20],
  });
  assert.deepEqual(snapshot.enemySummary, {
    championCount: 1,
    tagCounts: { Tank: 1, Fighter: 1 },
    basis: "data-dragon-champion-tags",
  });
});

test("the augment request candidate set is derived only from supplied offers", () => {
  const snapshot = buildRecommendationSnapshot(
    state({
      ownedAugments: [{ augmentId: 11 }],
      offeredAugments: [{ augmentId: 10, abilityContext: "E" }, null, { augmentId: 11 }],
    }),
    catalog,
    metadata,
  );

  const request = createAugmentRecommendationRequest(snapshot);
  assert.equal(request.kind, "augment");
  assert.deepEqual(request.candidateAugmentIds, [10, 11]);
});
