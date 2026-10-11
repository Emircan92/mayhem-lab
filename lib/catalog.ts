export type DescriptionQuality =
  | "ai-usable"
  | "contextual-usable"
  | "usable-with-missing-detail"
  | "unusable";

export type ChampionAbility = {
  name: string;
  description: string;
};

export type ChampionKit = {
  passive: ChampionAbility;
  q: ChampionAbility;
  w: ChampionAbility;
  e: ChampionAbility;
  r: ChampionAbility;
};

export type Champion = {
  id: number;
  key: string;
  name: string;
  title: string;
  tags: string[];
  kit: ChampionKit;
};

export type Augment = {
  id: number;
  internalName: string;
  name: string;
  rarity: "silver" | "gold" | "prismatic" | "unknown";
  description: string;
  descriptionStatus: string;
  descriptionQuality: DescriptionQuality;
  requiresAbilityContext: boolean;
  contextualTokens: string[];
  resolvedTokens: Array<Record<string, unknown>>;
  unresolvedTokens: string[];
  descriptionSource: Record<string, unknown>;
};

export type Item = {
  id: number;
  name: string;
  description: string;
  plainText: string;
  purchasable: boolean;
  gold: { base: number; total: number; sell: number };
  tags: string[];
  stats: Partial<Record<string, number>>;
  from: number[];
  into: number[];
  mapIds: number[];
  // Optional for older inventory snapshots; absent eligibility can never authorize a recommendation.
  eligibility?: {
    classification: string;
    reasons: string[];
    rawItemReference: string | null;
    memberships: Array<{ mode: string; modeReference: string; listReference: string; itemReference: string }>;
    storeVisibility: Record<string, unknown> | null;
    purchaseRestrictions: Record<string, unknown>;
  };
};
