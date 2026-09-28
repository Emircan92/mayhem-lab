import type { Augment, Champion, DescriptionQuality, Item } from "./catalog";
import type { ManualGameState, PlayerStats, SelectedAugment } from "./game-state";
import type {
  AugmentSelectionLocation,
  DataQualitySummary,
  DeterministicFact,
  DeterministicWarning,
  NormalizedChampion,
  NormalizedItem,
  NormalizedPlayerStats,
  NormalizedSelectedAugment,
  RecommendationSnapshot,
} from "./recommendation-contract";

export type RecommendationCatalog = {
  champions: Champion[];
  augments: Augment[];
  items: Item[];
};

export type SnapshotMetadata = {
  patch: string;
  generatedAt: string;
};

export class SnapshotNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotNormalizationError";
  }
}

const CRIT_CAP_RATIO = 1;
const INVENTORY_CAPACITY = 6;

function normalizeChampion(champion: Champion): NormalizedChampion {
  return {
    id: champion.id,
    key: champion.key,
    name: champion.name,
    title: champion.title,
    tags: [...champion.tags],
  };
}

export function normalizeCatalogItem(item: Item): NormalizedItem {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    plainText: item.plainText,
    stats: { ...item.stats },
    tags: [...item.tags],
    purchasable: item.purchasable,
    catalogStatus: item.purchasable ? "purchasable" : "non-shop-or-transformed",
    gold: {
      total: item.gold.total,
      sell: item.gold.sell,
    },
  };
}

function normalizeSelectedAugment(augment: Augment, selected: SelectedAugment): NormalizedSelectedAugment {
  return {
    id: augment.id,
    internalName: augment.internalName,
    name: augment.name,
    description: augment.description,
    rarity: augment.rarity,
    ...(selected.abilityContext ? { abilityContext: selected.abilityContext } : {}),
    requiresAbilityContext: augment.requiresAbilityContext,
    descriptionStatus: augment.descriptionStatus,
    descriptionQuality: augment.descriptionQuality,
    unresolvedTokens: [...augment.unresolvedTokens],
    descriptionSource: { ...augment.descriptionSource },
  };
}

function assertValidStat(key: keyof PlayerStats, value: number) {
  if (!Number.isFinite(value) || value < 0) {
    throw new SnapshotNormalizationError(`Invalid ${key} value: ${String(value)}.`);
  }
}

function normalizeStats(stats: PlayerStats): NormalizedPlayerStats {
  const normalized: NormalizedPlayerStats = {};
  if (stats.critChance !== undefined) {
    assertValidStat("critChance", stats.critChance);
    normalized.critChance = {
      value: stats.critChance / 100,
      unit: "ratio",
      reportedPercent: stats.critChance,
    };
  }
  if (stats.attackSpeed !== undefined) {
    assertValidStat("attackSpeed", stats.attackSpeed);
    normalized.attackSpeed = { value: stats.attackSpeed, unit: "attacks-per-second" };
  }
  const pointStats = [
    "attackDamage",
    "abilityPower",
    "armor",
    "magicResistance",
    "health",
  ] as const;
  for (const key of pointStats) {
    const value = stats[key];
    if (value === undefined) continue;
    assertValidStat(key, value);
    normalized[key] = { value, unit: "points" };
  }
  if (stats.abilityHaste !== undefined) {
    assertValidStat("abilityHaste", stats.abilityHaste);
    normalized.abilityHaste = { value: stats.abilityHaste, unit: "ability-haste" };
  }
  return normalized;
}

function augmentWarningsAndFacts(
  augment: NormalizedSelectedAugment,
  location: AugmentSelectionLocation,
  facts: DeterministicFact[],
  warnings: DeterministicWarning[],
) {
  if (augment.requiresAbilityContext) {
    if (augment.abilityContext) {
      facts.push({
        kind: "augment-context",
        augmentId: augment.id,
        augmentName: augment.name,
        abilityContext: augment.abilityContext,
        ...location,
      });
    } else {
      warnings.push({
        kind: "augment-context-missing",
        augmentId: augment.id,
        augmentName: augment.name,
        message: "The affected ability was not supplied; recommendation confidence may be reduced.",
        ...location,
      });
    }
  }

  if (augment.descriptionQuality === "usable-with-missing-detail") {
    warnings.push({
      kind: "augment-description-missing-detail",
      augmentId: augment.id,
      augmentName: augment.name,
      unresolvedTokens: [...augment.unresolvedTokens],
      message: "The Mayhem description is strategically usable but is missing exact numerical or detail information.",
      ...location,
    });
  } else if (augment.descriptionQuality === "unusable") {
    warnings.push({
      kind: "augment-description-unusable",
      augmentId: augment.id,
      augmentName: augment.name,
      message: "The selected augment description is not reliable enough for recommendation reasoning.",
      ...location,
    });
  }
}

function countItemIds(items: NormalizedItem[]) {
  const counts = new Map<number, { item: NormalizedItem; count: number }>();
  for (const item of items) {
    const current = counts.get(item.id);
    counts.set(item.id, { item, count: (current?.count ?? 0) + 1 });
  }
  return counts;
}

function summarizeDataQuality(augments: NormalizedSelectedAugment[]): DataQualitySummary {
  const descriptionQualityCounts: Record<DescriptionQuality, number> = {
    "ai-usable": 0,
    "contextual-usable": 0,
    "usable-with-missing-detail": 0,
    unusable: 0,
  };
  for (const augment of augments) descriptionQualityCounts[augment.descriptionQuality] += 1;

  return {
    selectedAugmentCount: augments.length,
    descriptionQualityCounts,
    missingDetailAugmentIds: augments
      .filter((augment) => augment.descriptionQuality === "usable-with-missing-detail")
      .map((augment) => augment.id),
    unusableAugmentIds: augments
      .filter((augment) => augment.descriptionQuality === "unusable")
      .map((augment) => augment.id),
    unresolvedTokens: augments
      .filter((augment) => augment.unresolvedTokens.length > 0)
      .map((augment) => ({ augmentId: augment.id, tokens: [...augment.unresolvedTokens] })),
  };
}

export function buildRecommendationSnapshot(
  state: ManualGameState,
  catalog: RecommendationCatalog,
  metadata: SnapshotMetadata,
): RecommendationSnapshot {
  const championById = new Map(catalog.champions.map((champion) => [champion.id, champion]));
  const augmentById = new Map(catalog.augments.map((augment) => [augment.id, augment]));
  const itemById = new Map(catalog.items.map((item) => [item.id, item]));
  const facts: DeterministicFact[] = [];
  const warnings: DeterministicWarning[] = [];

  let champion: NormalizedChampion | null = null;
  if (state.championId === undefined) {
    warnings.push({
      kind: "missing-required-selection",
      selection: "champion",
      message: "No current champion is selected.",
    });
  } else {
    const catalogChampion = championById.get(state.championId);
    if (!catalogChampion) {
      throw new SnapshotNormalizationError(`Unknown champion ID ${state.championId}.`);
    }
    champion = normalizeChampion(catalogChampion);
  }

  const seenOwnedAugmentIds = new Set<number>();
  const ownedAugments = state.ownedAugments.map((selected) => {
    if (seenOwnedAugmentIds.has(selected.augmentId)) {
      throw new SnapshotNormalizationError(`Duplicate owned augment ID ${selected.augmentId}.`);
    }
    seenOwnedAugmentIds.add(selected.augmentId);
    const augment = augmentById.get(selected.augmentId);
    if (!augment) throw new SnapshotNormalizationError(`Unknown owned augment ID ${selected.augmentId}.`);
    const normalized = normalizeSelectedAugment(augment, selected);
    augmentWarningsAndFacts(normalized, { selection: "owned" }, facts, warnings);
    return normalized;
  });

  const offeredAugments = state.offeredAugments.map((selected, index) => {
    if (!selected) return null;
    const augment = augmentById.get(selected.augmentId);
    if (!augment) {
      throw new SnapshotNormalizationError(`Unknown offered augment ID ${selected.augmentId} in slot ${index + 1}.`);
    }
    const normalized = normalizeSelectedAugment(augment, selected);
    augmentWarningsAndFacts(
      normalized,
      { selection: "offered", offeredSlot: (index + 1) as 1 | 2 | 3 },
      facts,
      warnings,
    );
    return normalized;
  }) as RecommendationSnapshot["offeredAugments"];

  const items = state.itemIds.map((itemId) => {
    const item = itemById.get(itemId);
    if (!item) throw new SnapshotNormalizationError(`Unknown item ID ${itemId}.`);
    return normalizeCatalogItem(item);
  });
  const itemCounts = countItemIds(items);
  for (const { item, count } of itemCounts.values()) {
    facts.push({ kind: "item-owned", itemId: item.id, itemName: item.name, count });
  }
  facts.push({
    kind: "inventory-summary",
    slotCount: items.length,
    slotCapacity: INVENTORY_CAPACITY,
    duplicateItemIds: [...itemCounts.values()]
      .filter(({ count }) => count > 1)
      .map(({ item }) => item.id),
  });

  const seenEnemyIds = new Set<number>();
  const enemies = state.enemyChampionIds.map((championId) => {
    if (seenEnemyIds.has(championId)) {
      throw new SnapshotNormalizationError(`Duplicate enemy champion ID ${championId}.`);
    }
    seenEnemyIds.add(championId);
    const enemy = championById.get(championId);
    if (!enemy) throw new SnapshotNormalizationError(`Unknown enemy champion ID ${championId}.`);
    return normalizeChampion(enemy);
  });
  const tagCounts: Record<string, number> = {};
  for (const enemy of enemies) {
    for (const tag of enemy.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
  }

  const stats = normalizeStats(state.stats);
  if (stats.critChance && stats.critChance.value >= CRIT_CAP_RATIO) {
    facts.push({
      kind: "stat-cap",
      stat: "critChance",
      value: stats.critChance.value,
      cap: CRIT_CAP_RATIO,
      unit: "ratio",
      constraint: "additional-critical-strike-chance-has-no-intrinsic-value",
    });
  }

  const allSelectedAugments = [
    ...ownedAugments,
    ...offeredAugments.filter((augment): augment is NormalizedSelectedAugment => augment !== null),
  ];

  return {
    schemaVersion: 1,
    patch: metadata.patch,
    generatedAt: metadata.generatedAt,
    champion,
    ownedAugments,
    offeredAugments,
    items,
    enemies,
    enemySummary: {
      championCount: enemies.length,
      tagCounts,
      basis: "data-dragon-champion-tags",
    },
    stats,
    facts,
    warnings,
    dataQuality: summarizeDataQuality(allSelectedAugments),
  };
}
