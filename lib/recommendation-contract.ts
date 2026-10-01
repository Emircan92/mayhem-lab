import type { ChampionKit, DescriptionQuality } from "./catalog";
import type { AbilityContext } from "./game-state";

export type NormalizedChampion = {
  id: number;
  key: string;
  name: string;
  title: string;
  tags: string[];
  kit: ChampionKit;
};

export type NormalizedSelectedAugment = {
  id: number;
  internalName: string;
  name: string;
  description: string;
  rarity: "silver" | "gold" | "prismatic" | "unknown";
  abilityContext?: AbilityContext;
  requiresAbilityContext: boolean;
  descriptionStatus: string;
  descriptionQuality: DescriptionQuality;
  unresolvedTokens: string[];
  descriptionSource: Record<string, unknown>;
};

export type NormalizedItem = {
  id: number;
  name: string;
  description: string;
  plainText: string;
  stats: Partial<Record<string, number>>;
  tags: string[];
  purchasable: boolean;
  catalogStatus: "purchasable" | "non-shop-or-transformed";
  gold: {
    total: number;
    sell: number;
  };
};

export type NormalizedStat =
  | { value: number; unit: "ratio"; reportedPercent: number }
  | { value: number; unit: "attacks-per-second" }
  | { value: number; unit: "points" }
  | { value: number; unit: "ability-haste" };

export type NormalizedPlayerStats = {
  critChance?: Extract<NormalizedStat, { unit: "ratio" }>;
  attackSpeed?: Extract<NormalizedStat, { unit: "attacks-per-second" }>;
  attackDamage?: Extract<NormalizedStat, { unit: "points" }>;
  abilityPower?: Extract<NormalizedStat, { unit: "points" }>;
  armor?: Extract<NormalizedStat, { unit: "points" }>;
  magicResistance?: Extract<NormalizedStat, { unit: "points" }>;
  abilityHaste?: Extract<NormalizedStat, { unit: "ability-haste" }>;
  health?: Extract<NormalizedStat, { unit: "points" }>;
};

export type AugmentSelectionLocation =
  | { selection: "owned" }
  | { selection: "offered"; offeredSlot: 1 | 2 | 3 };

export type DeterministicFact =
  | {
      kind: "stat-cap";
      stat: "critChance";
      value: number;
      cap: 1;
      unit: "ratio";
      constraint: "additional-critical-strike-chance-has-no-intrinsic-value";
    }
  | ({
      kind: "augment-context";
      augmentId: number;
      augmentName: string;
      abilityContext: AbilityContext;
    } & AugmentSelectionLocation)
  | {
      kind: "item-owned";
      itemId: number;
      itemName: string;
      count: number;
    }
  | {
      kind: "inventory-summary";
      slotCount: number;
      slotCapacity: 6;
      duplicateItemIds: number[];
    };

export type DeterministicWarning =
  | {
      kind: "missing-required-selection";
      selection: "champion";
      message: string;
    }
  | ({
      kind: "augment-context-missing";
      augmentId: number;
      augmentName: string;
      message: string;
    } & AugmentSelectionLocation)
  | ({
      kind: "augment-description-missing-detail";
      augmentId: number;
      augmentName: string;
      unresolvedTokens: string[];
      message: string;
    } & AugmentSelectionLocation)
  | ({
      kind: "augment-description-unusable";
      augmentId: number;
      augmentName: string;
      message: string;
    } & AugmentSelectionLocation);

export type EnemyCompositionSummary = {
  championCount: number;
  tagCounts: Record<string, number>;
  basis: "data-dragon-champion-tags";
};

export type DataQualitySummary = {
  selectedAugmentCount: number;
  descriptionQualityCounts: Record<DescriptionQuality, number>;
  missingDetailAugmentIds: number[];
  unusableAugmentIds: number[];
  unresolvedTokens: Array<{
    augmentId: number;
    tokens: string[];
  }>;
};

export type RecommendationSnapshot = {
  schemaVersion: 2;
  patch: string;
  generatedAt: string;
  champion: NormalizedChampion | null;
  ownedAugments: NormalizedSelectedAugment[];
  offeredAugments: [
    NormalizedSelectedAugment | null,
    NormalizedSelectedAugment | null,
    NormalizedSelectedAugment | null,
  ];
  items: NormalizedItem[];
  enemies: NormalizedChampion[];
  enemySummary: EnemyCompositionSummary;
  stats: NormalizedPlayerStats;
  facts: DeterministicFact[];
  warnings: DeterministicWarning[];
  dataQuality: DataQualitySummary;
};

export type RecommendationCandidate = {
  id: number;
  name: string;
  reason: string;
  preferWhen?: string;
};

export type RecommendationConfidence = "high" | "medium" | "low";

type RecommendationResponseBase = {
  schemaVersion: 1;
  primary: Omit<RecommendationCandidate, "preferWhen">;
  alternatives: RecommendationCandidate[];
  buildDirection?: string;
  warnings: string[];
  confidence: RecommendationConfidence;
};

export type AugmentRecommendationRequest = {
  schemaVersion: 1;
  kind: "augment";
  snapshot: RecommendationSnapshot;
  candidateAugmentIds: number[];
};

export type ItemRecommendationRequest = {
  schemaVersion: 1;
  kind: "item";
  snapshot: RecommendationSnapshot;
  candidateItems: NormalizedItem[];
};

export type RecommendationRequest = AugmentRecommendationRequest | ItemRecommendationRequest;

export type AugmentRecommendationResponse = RecommendationResponseBase & {
  kind: "augment";
};

export type ItemRecommendationResponse = RecommendationResponseBase & {
  kind: "item";
};

export type RecommendationResponse = AugmentRecommendationResponse | ItemRecommendationResponse;

export function createAugmentRecommendationRequest(
  snapshot: RecommendationSnapshot,
): AugmentRecommendationRequest {
  return {
    schemaVersion: 1,
    kind: "augment",
    snapshot,
    candidateAugmentIds: [
      ...new Set(
        snapshot.offeredAugments
          .filter((augment): augment is NormalizedSelectedAugment => augment !== null)
          .map((augment) => augment.id),
      ),
    ],
  };
}

export function createItemRecommendationRequest(
  snapshot: RecommendationSnapshot,
  candidateItems: NormalizedItem[],
): ItemRecommendationRequest {
  return {
    schemaVersion: 1,
    kind: "item",
    snapshot,
    candidateItems,
  };
}
