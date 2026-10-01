import assert from "node:assert/strict";
import test from "node:test";

import augmentsSnapshot from "../data/generated/16.19.1/augments.json";
import championsSnapshot from "../data/generated/16.19.1/champions.json";
import fixture from "../data/calibration/volibear-dropkick.json";
import itemsSnapshot from "../data/generated/16.19.1/items.json";
import manifest from "../data/generated/16.19.1/manifest.json";
import type { Augment, Champion, Item } from "../lib/catalog";
import type { ManualGameState } from "../lib/game-state";
import { buildRecommendationSnapshot } from "../lib/preprocess-game-state";
import { createAugmentRecommendationRequest } from "../lib/recommendation-contract";
import { buildRecommendationPrompt } from "../lib/recommendation/build-prompt";

test("the Volibear calibration carries player and enemy kits without changing legal candidates", () => {
  const snapshot = buildRecommendationSnapshot(
    fixture.request.state as ManualGameState,
    {
      champions: championsSnapshot.champions as Champion[],
      augments: augmentsSnapshot.augments as Augment[],
      items: itemsSnapshot.items as Item[],
    },
    { patch: manifest.riotDataDragonPatch, generatedAt: manifest.generatedAt },
  );
  const request = createAugmentRecommendationRequest(snapshot);
  const prompt = buildRecommendationPrompt(request);

  assert.equal(snapshot.champion?.name, "Volibear");
  assert.equal(snapshot.champion?.kit.w.name, "Frenzied Maul");
  assert.deepEqual(snapshot.enemies.map((enemy) => enemy.name), ["Jhin", "Akali", "Zed", "Viktor", "Zac"]);
  assert.ok(snapshot.enemies.every((enemy) => enemy.kit.passive.description && enemy.kit.r.description));
  assert.deepEqual(request.candidateAugmentIds, [1018, 2006, 1310]);
  assert.match(prompt.instructions, /Only from the supplied candidates|only from the supplied candidates/i);
  assert.match(prompt.instructions, /state-specific interaction reasoning/);
});
