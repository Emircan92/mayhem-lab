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
  }
});
