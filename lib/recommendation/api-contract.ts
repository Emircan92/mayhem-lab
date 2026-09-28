import { z } from "zod";

import type { ManualGameState } from "../game-state";
import type { RecommendationRequest, RecommendationResponse } from "../recommendation-contract";
import type { ProviderMetadata } from "./provider";

const selectedAugmentSchema = z.object({
  augmentId: z.number().int(),
  abilityContext: z.string().trim().min(1).max(80).optional(),
});

const optionalStat = z.number().finite().nonnegative().optional();

const manualGameStateSchema = z.object({
  championId: z.number().int().optional(),
  ownedAugments: z.array(selectedAugmentSchema).max(32),
  offeredAugments: z.tuple([
    selectedAugmentSchema.nullable(),
    selectedAugmentSchema.nullable(),
    selectedAugmentSchema.nullable(),
  ]),
  itemIds: z.array(z.number().int()).max(6),
  enemyChampionIds: z.array(z.number().int()).max(5),
  stats: z.object({
    critChance: optionalStat,
    attackSpeed: optionalStat,
    attackDamage: optionalStat,
    abilityPower: optionalStat,
    armor: optionalStat,
    magicResistance: optionalStat,
    abilityHaste: optionalStat,
    health: optionalStat,
  }),
}).superRefine((state, context) => {
  const owned = state.ownedAugments.map((augment) => augment.augmentId);
  if (new Set(owned).size !== owned.length) {
    context.addIssue({ code: "custom", path: ["ownedAugments"], message: "Owned augment IDs must be unique." });
  }
  if (new Set(state.enemyChampionIds).size !== state.enemyChampionIds.length) {
    context.addIssue({ code: "custom", path: ["enemyChampionIds"], message: "Enemy champion IDs must be unique." });
  }
});

export const recommendationApiInputSchema = z.object({
  kind: z.enum(["augment", "item"]),
  state: manualGameStateSchema,
});

export type RecommendationApiInput = {
  kind: "augment" | "item";
  state: ManualGameState;
};

export type RecommendationApiSuccess = {
  ok: true;
  recommendation: RecommendationResponse;
  debug: {
    request: RecommendationRequest;
    provider: ProviderMetadata;
  };
};

export type RecommendationApiFailure = {
  ok: false;
  error: {
    code: "INVALID_REQUEST" | "NOT_CONFIGURED" | "PROVIDER_ERROR" | "INVALID_MODEL_RESPONSE";
    message: string;
    details?: string[];
  };
};

export type RecommendationApiResponse = RecommendationApiSuccess | RecommendationApiFailure;

