import test from "node:test";
import assert from "node:assert/strict";

import {
  createEmptyGameState,
  parseStoredGameState,
  recordOfferedAugment,
  serializeGameState,
  type CatalogIds,
} from "../lib/game-state";

const catalog: CatalogIds = {
  championIds: new Set([1, 2, 3]),
  augmentIds: new Set([10, 11, 12]),
  itemIds: new Set([20, 21]),
};

test("missing or malformed local state safely becomes an empty game", () => {
  assert.deepEqual(parseStoredGameState(null, catalog), createEmptyGameState());
  assert.deepEqual(parseStoredGameState("not json", catalog), createEmptyGameState());
});

test("recording any actual offer copies its context, clears all slots, and survives storage", () => {
  for (const index of [0, 1, 2]) {
    const state = createEmptyGameState();
    state.offeredAugments = [
      { augmentId: 10, abilityContext: "Q" },
      { augmentId: 11, abilityContext: "Passive" },
      { augmentId: 12, abilityContext: "Custom ability" },
    ];
    const selected = { ...state.offeredAugments[index]! };
    const result = recordOfferedAugment(state, index);
    assert.deepEqual(result.ownedAugments, [selected]);
    assert.notEqual(result.ownedAugments[0], state.offeredAugments[index]);
    assert.deepEqual(result.offeredAugments, [null, null, null]);
    assert.deepEqual(parseStoredGameState(serializeGameState(result, "16.19.1"), catalog), result);
    assert.equal(state.ownedAugments.length, 0, "input was not mutated");
    assert.equal(state.offeredAugments.filter(Boolean).length, 3);
  }
});

test("recording prevents duplicate ownership, repeated clicks, empty and invalid slots", () => {
  const state = createEmptyGameState();
  state.ownedAugments = [{ augmentId: 10, abilityContext: "R" }];
  state.offeredAugments = [{ augmentId: 10, abilityContext: "Q" }, { augmentId: 11 }, null];
  for (const index of [0, 2, -1, 3]) assert.equal(recordOfferedAugment(state, index), state);
  const recorded = recordOfferedAugment(state, 1);
  assert.deepEqual(recorded.ownedAugments, [{ augmentId: 10, abilityContext: "R" }, { augmentId: 11 }]);
  assert.equal(recordOfferedAugment(recorded, 1), recorded);
});

test("stored game state preserves useful values and drops stale catalog IDs", () => {
  const serialized = JSON.stringify({
    schemaVersion: 1,
    dataPatch: "old-patch",
    state: {
      championId: 1,
      ownedAugments: [
        { augmentId: 10, abilityContext: "Q" },
        { augmentId: 10 },
        { augmentId: 999 },
      ],
      offeredAugments: [{ augmentId: 11, abilityContext: "Passive" }, { augmentId: 999 }, null],
      itemIds: [20, 999, 21],
      enemyChampionIds: [2, 2, 999, 3],
      stats: { critChance: 100, attackSpeed: -1, health: "lots" },
    },
  });

  assert.deepEqual(parseStoredGameState(serialized, catalog), {
    championId: 1,
    ownedAugments: [{ augmentId: 10, abilityContext: "Q" }],
    offeredAugments: [{ augmentId: 11, abilityContext: "Passive" }, null, null],
    itemIds: [20, 21],
    enemyChampionIds: [2, 3],
    stats: { critChance: 100 },
  });
});

test("serialization records the snapshot patch without adding display state", () => {
  const serialized = serializeGameState(createEmptyGameState(), "16.19.1");
  const stored = JSON.parse(serialized);

  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.dataPatch, "16.19.1");
  assert.deepEqual(Object.keys(stored.state).sort(), [
    "enemyChampionIds",
    "itemIds",
    "offeredAugments",
    "ownedAugments",
    "stats",
  ]);
});
