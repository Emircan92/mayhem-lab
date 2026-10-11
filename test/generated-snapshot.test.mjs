import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateSnapshot } from "../scripts/refresh-data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the bundled generated snapshot is internally consistent and pinned", async () => {
  const generatedRoot = path.join(ROOT, "data", "generated");
  const versions = (await readdir(generatedRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(versions.length > 0, "at least one generated snapshot must be bundled");

  for (const version of versions) {
    const directory = path.join(generatedRoot, version);
    const [championFile, itemFile, augmentFile, manifest] = await Promise.all(
      ["champions.json", "items.json", "augments.json", "manifest.json"].map((fileName) =>
        readFile(path.join(directory, fileName), "utf8").then(JSON.parse),
      ),
    );
    const validation = validateSnapshot({
      champions: championFile.champions,
      items: itemFile.items,
      augments: augmentFile.augments,
    });

    assert.equal(validation.valid, true);
    assert.equal(manifest.riotDataDragonPatch, version);
    assert.equal(manifest.communityDragon.runtimeUsesLatest, false);
    assert.equal(Object.values(manifest.sources).some((url) => /\/latest\//i.test(url)), false);
    assert.equal(manifest.counts.champions, championFile.champions.length);
    assert.equal(manifest.counts.items, itemFile.items.length);
    assert.equal(manifest.counts.augments, augmentFile.augments.length);
    assert.equal(itemFile.schemaVersion, 2);
    assert.equal(itemFile.eligibilitySources.communityDragonPatch, manifest.communityDragon.patch);
    assert.deepEqual(itemFile.eligibilityDiagnostics.errors, []);
    assert.ok(itemFile.eligibilityDiagnostics.modeMembership.KIWI.length > 0);
    for (const source of Object.values(itemFile.eligibilitySources.sources)) {
      assert.match(source.jsonSha256, /^[a-f0-9]{64}$/);
      assert.doesNotMatch(source.url, /\/latest\//);
    }
    for (const item of itemFile.items) {
      assert.ok(item.eligibility.reasons.length > 0);
      if (item.eligibility.classification === "ordinary-shop") {
        assert.ok(item.eligibility.memberships.some((entry) => entry.mode === "KIWI"));
        assert.equal(item.eligibility.storeVisibility.mInStore, true);
        assert.notEqual(item.eligibility.storeVisibility.mHidefromAll, true);
      }
    }
    assert.equal(championFile.schemaVersion, 2);
    for (const champion of championFile.champions) {
      assert.deepEqual(Object.keys(champion.kit), ["passive", "q", "w", "e", "r"]);
      for (const ability of Object.values(champion.kit)) {
        assert.ok(ability.name.trim());
        assert.ok(ability.description.trim());
        assert.equal(/<[^>]+>/.test(ability.description), false);
      }
    }

    const volibear = championFile.champions.find((champion) => champion.name === "Volibear");
    assert.equal(volibear?.kit.q.name, "Thundering Smash");
    assert.equal(volibear?.kit.w.name, "Frenzied Maul");
  }
});
