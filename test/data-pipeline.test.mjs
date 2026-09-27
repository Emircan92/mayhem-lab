import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanRichText,
  expandStringReferences,
  findUnresolvedTokens,
  normalizeAugments,
  resolveDirectDescriptionTokens,
  validateSnapshot,
} from "../scripts/refresh-data.mjs";

test("cleanRichText removes Riot presentation markup but preserves readable text", () => {
  assert.equal(
    cleanRichText("Gain %i:scaleAD% <physicalDamage>10 AD</physicalDamage><br><br>Now &amp; later."),
    "Gain 10 AD\nNow & later.",
  );
});

test("findUnresolvedTokens returns unique sorted Riot placeholders", () => {
  assert.deepEqual(findUnresolvedTokens("Gain @Amount@ and @Rate*100@, then @Amount@."), [
    "@Amount@",
    "@Rate*100@",
  ]);
});

test("expandStringReferences resolves only known CommunityDragon string references", () => {
  const strings = { known_key: "Resolved text" };
  assert.equal(
    expandStringReferences("Use {{ Known_Key }}; keep {{SpellName}}.", strings),
    "Use Resolved text; keep {{SpellName}}.",
  );
});

test("direct token normalization resolves constant KIWI values but keeps formulas untouched", () => {
  const result = resolveDirectDescriptionTokens(
    "Your @SpellName@ gains @Haste@ Haste and @DynamicValue@ power.",
    {
      DataValues: [
        { name: "Haste", values: [100, 100, 100, 100, 100, 100, 100] },
      ],
      mSpellCalculations: { DynamicValue: { mFormulaParts: [] } },
    },
  );

  assert.equal(
    result.description,
    "Your affected ability gains 100 Haste and @DynamicValue@ power.",
  );
  assert.deepEqual(result.contextualTokens, ["@SpellName@"]);
  assert.equal(result.resolvedTokens[0].dataValue, "Haste");
});

test("ability context normalization also handles CommunityDragon mustache placeholders", () => {
  const result = resolveDirectDescriptionTokens("Hit champions with {{SpellName}}.");

  assert.equal(result.description, "Hit champions with the affected ability.");
  assert.deepEqual(result.contextualTokens, ["{{SpellName}}"]);
  assert.deepEqual(findUnresolvedTokens(result.description), []);
});

test("KIWI membership joins by platform ID and applies an internal-name override", () => {
  const augments = normalizeAugments({
    kiwiData: {
      "Maps/Test": {
        __type: "AugmentData",
        AugmentPlatformId: 42,
        AugmentNameId: "TestAugment",
        NameTra: "Kiwi_Test_Name",
        DescriptionTra: "Kiwi_Test_Summary",
      },
    },
    clientMetadata: [
      {
        id: 42,
        augmentNameId: "TestAugment",
        nameTRA: "Fallback Name",
        rarity: "kGold",
        augmentSmallIconPath: "/lol-game-data/assets/ASSETS/UX/Kiwi/test.png",
      },
    ],
    stringTable: {
      kiwi_test_name: "Test Name",
      kiwi_test_summary: "Gain @Amount@ power.",
    },
    overrides: {
      TestAugment: {
        description: "The affected ability gains power.",
        reason: "Test override.",
        requiresAbilityContext: true,
      },
    },
    communityPatch: "16.19",
    sourceUrl: "https://example.test/strings.json",
  });

  assert.equal(augments.length, 1);
  assert.equal(augments[0].name, "Test Name");
  assert.equal(augments[0].rarity, "gold");
  assert.equal(augments[0].description, "The affected ability gains power.");
  assert.equal(augments[0].descriptionStatus, "curated-override");
  assert.equal(augments[0].descriptionQuality, "contextual-usable");
  assert.equal(augments[0].requiresAbilityContext, true);
  assert.deepEqual(augments[0].unresolvedTokens, []);
});

test("validation fails duplicate lookup identities and surfaces unresolved descriptions", () => {
  const validation = validateSnapshot({
    champions: [{ id: 1, key: "One", name: "One" }],
    items: [{ id: 1, name: "Item" }],
    augments: [
      {
        id: 1,
        internalName: "First",
        name: "Same Name",
        description: "Gain @Amount@ power.",
        descriptionStatus: "unresolved-tokens",
        unresolvedTokens: ["@Amount@"],
      },
      {
        id: 2,
        internalName: "Second",
        name: "Same-Name",
        description: "Clean.",
        descriptionStatus: "clean",
        unresolvedTokens: [],
      },
    ],
  });

  assert.equal(validation.valid, false);
  assert.equal(validation.checks.augmentDisplayNamesUnique, false);
  assert.equal(validation.summary.unresolvedDescriptionCount, 1);
});
