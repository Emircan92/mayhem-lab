// Eligibility comes from extracted Riot assets, not Data Dragon's generic purchasable flag.
// This schema is intentionally reviewed: new/opaque ItemData fields fail closed for that item.
const ITEM_FIELDS = new Set(`__type itemID mDisplayName spellName maxStack mItemGroups itemVOGroup price
RestrictedBuffName consumed usableInStore consumeOnAcquire clickable mCanBeSold epicness mDataValues
sellBackModifier mCategories mItemDataAvailability mItemAttributes LastMajorChangeMajorPatchVersion
LastMajorChangeMinorPatchVersion mItemDataClient mItemCalloutSpectator mItemModifiers mItemCalculations
mAbilityHasteMod mFlatHPPoolMod mVFXResourceResolver mFlatMagicDamageMod mItemCalloutPlayer recipeItemLinks
mFlatArmorMod mFlatSpellBlockMod mEffectAmount mItemAdviceAttributes StringCalculations mFlatPhysicalDamageMod
mPercentAttackSpeedMod ShowCooldownVfxToAllies mPercentMovementSpeedMod mScripts flatMPPoolMod mRequiredSpellName
SecondaryEpicness PercentOmnivampMod PhysicalLethality mPercentHealingAmountMod percentBaseMPRegenMod
mPercentCooldownMod mFlatHPRegenMod flatMPRegenMod mDeathRecapName mFlatCritChanceMod ShowCooldownInPings
mRequiredBuffCurrencyName mPercentTenacityItemMod mFlatMovementSpeedMod specialRecipe DataValuesModeOverride
mDisabledDescriptionOverride mItemDataBuild RecommendationTags mPercentArmorPenetrationMod
mRequiredPurchaseIdentities mPercentLifeStealMod mCooldownShowDisabledDuration mFlatCritDamageMod
ShopOrderPriority mRequiredBuffCurrencyCost clearUndoHistory mRequiredChampion sidegradeItemLinks
mHiddenFromOpponents mPercentSlowResistMod mEffectByLevelAmount mFlatAttackRangeMod mFlatArmorPenetrationMod
mPercentMultiplicativeAttackSpeedMod requiredItemLinks mRequiredLevel mPercentBaseHPRegenMod
mFlatMagicPenetrationMod mPercentMagicPenetrationMod`.split(/\s+/));
const CONDITION_TYPES = {
  mRequiredLevel: "number", mRequiredSpellName: "string", RestrictedBuffName: "string",
  mRequiredBuffCurrencyName: "string", mRequiredBuffCurrencyCost: "number", mRequiredChampion: "string",
  mRequiredPurchaseIdentities: "array", requiredItemLinks: "array",
};
const AVAILABILITY_FIELDS = new Set(["__type", "mInStore", "mForceLoad", "mHidefromAll"]);
const MODE_PATH = "Maps/Shipping/Map12/Modes/KIWI";
const MODE_FIELDS = new Set(`__type mModeName Configs ConfigsClient itemLists mItemShopData
AdditionalPropertyDataPaths AnnouncementsMapping mRelativeColorization mCursorConfig mCursorConfigUpdate
mStatsUiData mExperienceCurveData mExperienceModData mDeathTimes mMapLocators mPerkReplacements
mGameModeConstants mGameplayConfig DefaultRespawnPoints mSurrenderSettings mAutoItemPurchasingConfig
LevelControllers`.split(/\s+/));

function binHash(value) {
  let hash = 0x811c9dc5;
  for (const char of value.toLowerCase()) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return `{${hash.toString(16).padStart(8, "0")}}`;
}

function resolver(documents, errors) {
  const entries = new Map();
  for (const document of documents) {
    if (document.__linked?.length) errors.push("Unresolved linked asset documents; merged inputs are required.");
    for (const [key, value] of Object.entries(document)) {
      if (!value || typeof value !== "object" || !value.__type) continue;
      for (const alias of [key.toLowerCase(), binHash(key)]) {
        const previous = entries.get(alias);
        if (previous && previous.value !== value) errors.push(`Ambiguous asset reference: ${alias}`);
        entries.set(alias, { key, value });
      }
    }
  }
  return (reference) => typeof reference === "string"
    ? entries.get(reference.toLowerCase()) ?? entries.get(binHash(reference)) : undefined;
}

export function deriveItemEligibility({ items, mapData, rawItems }) {
  const errors = [];
  const schemaChanges = [];
  const resolve = resolver([mapData, rawItems], errors);
  const targetMode = resolve(MODE_PATH);
  if (targetMode?.value.__type !== "GameModeMapData" || !Array.isArray(targetMode.value.itemLists)) {
    errors.push("Map12 KIWI GameModeMapData/itemLists missing or changed.");
  }
  if (targetMode) {
    const unknown = Object.keys(targetMode.value).filter((key) => !MODE_FIELDS.has(key));
    if (unknown.length) errors.push(`Unexpected KIWI mode fields: ${unknown.join(", ")}`);
  }
  const memberships = new Map();
  const modeMembership = {};
  for (const [modeReference, mode] of Object.entries(mapData)) {
    if (mode?.__type !== "GameModeMapData") continue;
    if (!Array.isArray(mode.itemLists)) {
      if (modeReference === targetMode?.key || mode.itemLists !== undefined) {
        errors.push(`GameModeMapData.itemLists missing or changed: ${modeReference}`);
      }
      continue;
    }
    const modeName = modeReference === targetMode?.key ? "KIWI" : modeReference.split("/").at(-1);
    const modeIds = new Set();
    for (const listReference of mode.itemLists) {
      const list = resolve(listReference);
      if (list?.value.__type !== "GameModeItemList" || !Array.isArray(list.value.mItems)) {
        errors.push(`Item list reference resolution/schema failure: ${modeReference} -> ${String(listReference)}`);
        continue;
      }
      const unknown = Object.keys(list.value).filter((key) => !["__type", "mItems"].includes(key));
      if (unknown.length) errors.push(`Unexpected item-list fields: ${list.key}: ${unknown.join(", ")}`);
      for (const itemReference of list.value.mItems) {
        const item = resolve(itemReference);
        if (item?.value.__type !== "ItemData" || !Number.isInteger(item.value.itemID) || item.value.itemID <= 0) {
          errors.push(`Item reference resolution/schema failure: ${list.key} -> ${String(itemReference)}`);
          continue;
        }
        modeIds.add(item.value.itemID);
        const membership = memberships.get(item.value.itemID) ?? [];
        membership.push({ mode: modeName, modeReference, listReference, itemReference });
        memberships.set(item.value.itemID, membership);
      }
    }
    modeMembership[modeName] = [...modeIds].sort((a, b) => a - b);
  }
  if (!modeMembership.KIWI?.length) errors.push("KIWI item membership is empty; refusing an empty eligibility catalog.");
  const definitions = new Map();
  for (const [reference, item] of Object.entries(rawItems)) {
    if (item?.__type !== "ItemData") continue;
    if (!Number.isInteger(item.itemID) || item.itemID <= 0) {
      errors.push(`Invalid raw ItemData.itemID: ${reference}`);
      continue;
    }
    if (definitions.has(item.itemID)) errors.push(`Duplicate raw ItemData.itemID: ${item.itemID}`);
    definitions.set(item.itemID, { reference, item });
  }
  const classified = items.map((item) => {
    const definition = definitions.get(item.id);
    const raw = definition?.item;
    const member = memberships.get(item.id) ?? [];
    const visibility = raw?.mItemDataAvailability ?? null;
    const restrictions = Object.fromEntries(Object.keys(CONDITION_TYPES)
      .filter((key) => raw && key in raw).map((key) => [key, raw[key]]));
    const unknown = raw ? Object.keys(raw).filter((key) => !ITEM_FIELDS.has(key)) : [];
    const invalidConditions = Object.entries(restrictions).filter(([key, value]) => {
      const type = CONDITION_TYPES[key];
      return type === "array" ? !Array.isArray(value) || value.some((entry) => typeof entry !== "string")
        : typeof value !== type || (type === "number" && (!Number.isFinite(value) || value < 0));
    }).map(([key]) => key);
    const invalidVisibility = visibility === null || visibility.__type !== "ItemDataAvailability"
      || Object.entries(visibility).some(([key, value]) => !AVAILABILITY_FIELDS.has(key)
        || (key !== "__type" && typeof value !== "boolean"));
    if (unknown.length || invalidConditions.length || (raw && invalidVisibility)) {
      schemaChanges.push({ id: item.id, unknownFields: unknown, invalidConditions, invalidVisibility });
    }
    let classification;
    let reasons;
    if (!raw) {
      classification = "unresolved"; reasons = ["raw-definition-missing"];
    } else if (!member.some((entry) => entry.mode === "KIWI")) {
      classification = member.length ? "other-mode" : "legacy-or-inaccessible";
      reasons = ["absent-from-KIWI-item-lists"];
    } else if (unknown.length || invalidConditions.length || invalidVisibility) {
      classification = "unresolved";
      reasons = [...unknown.map((key) => `unknown-ItemData-field:${key}`),
        ...invalidConditions.map((key) => `invalid-condition:${key}`),
        ...(invalidVisibility ? ["missing-or-unsupported-store-visibility"] : [])];
    } else if (restrictions.mRequiredSpellName) {
      // CanPurchase is used by quest rewards, but other spells can also gate script grants.
      classification = "quest-or-script-gated"; reasons = ["required-purchase-spell"];
    } else if (Object.values(restrictions).some((value) => Array.isArray(value) ? value.length : Boolean(value))) {
      classification = "conditional"; reasons = ["purchase-restrictions-require-runtime-evidence"];
    } else if (visibility.mInStore !== true || visibility.mHidefromAll === true) {
      classification = "legacy-or-inaccessible"; reasons = ["not-explicitly-visible-in-store"];
    } else {
      classification = "ordinary-shop"; reasons = ["KIWI-membership", "explicit-store-visibility", "no-purchase-restrictions"];
    }
    return { ...item, eligibility: {
      classification, reasons, rawItemReference: definition?.reference ?? null,
      memberships: member, storeVisibility: visibility, purchaseRestrictions: restrictions,
    } };
  });
  const missingCatalogIds = (modeMembership.KIWI ?? []).filter((id) => !items.some((item) => item.id === id));
  return { items: classified, diagnostics: { errors, schemaChanges, missingCatalogIds, modeMembership,
    classifications: classified.reduce((counts, item) => {
      const key = item.eligibility.classification;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}) } };
}

export function compareItemMembership(previous, current, previousPatch) {
  if (!previous?.eligibilityDiagnostics?.modeMembership) {
    return { previousPatch: previousPatch ?? null, status: "no-eligibility-baseline", modes: {}, classificationChanges: [] };
  }
  const before = previous.eligibilityDiagnostics.modeMembership;
  const after = current.diagnostics.modeMembership;
  const modes = Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].sort().map((mode) => [mode, {
    added: (after[mode] ?? []).filter((id) => !(before[mode] ?? []).includes(id)),
    removed: (before[mode] ?? []).filter((id) => !(after[mode] ?? []).includes(id)),
  }]));
  const priorItems = new Map(previous.items.map((item) => [item.id, item.eligibility?.classification]));
  const classificationChanges = current.items.filter((item) => priorItems.has(item.id)
    && priorItems.get(item.id) !== item.eligibility.classification).map((item) => ({
      id: item.id, before: priorItems.get(item.id), after: item.eligibility.classification,
    }));
  return { previousPatch, status: "compared", modes, classificationChanges };
}
