import type { Item } from "../catalog";
import type { ManualGameState } from "../game-state";
import {
  buildRecommendationSnapshot,
  type RecommendationCatalog,
  type SnapshotMetadata,
} from "../preprocess-game-state";
import {
  createAugmentRecommendationRequest,
  createItemRecommendationRequest,
  type RecommendationRequest,
  type RecommendationResponse,
} from "../recommendation-contract";
import { buildRecommendationPrompt, type RecommendationPrompt } from "./build-prompt";
import { buildCompletedItemCandidates } from "./candidate-policy";
import type { ProviderMetadata, RecommendationProvider } from "./provider";
import { validateRecommendationResponse } from "./validate-response";

export class RecommendationRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecommendationRequestError";
  }
}

export class InvalidModelResponseError extends Error {
  constructor(readonly issues: string[]) {
    super("The model returned a recommendation that failed local validation.");
    this.name = "InvalidModelResponseError";
  }
}

export type RecommendationRun = {
  request: RecommendationRequest;
  prompt: RecommendationPrompt;
  recommendation: RecommendationResponse;
  provider: ProviderMetadata;
};

export function createRecommendationRequest(
  kind: "augment" | "item",
  state: ManualGameState,
  catalog: RecommendationCatalog,
  metadata: SnapshotMetadata,
  candidateSource: Item[],
): RecommendationRequest {
  const snapshot = buildRecommendationSnapshot(state, catalog, metadata);
  if (!snapshot.champion) throw new RecommendationRequestError("Select your current champion first.");

  if (kind === "augment") {
    const request = createAugmentRecommendationRequest(snapshot);
    if (request.candidateAugmentIds.length < 1) {
      throw new RecommendationRequestError("Add at least one offered augment before requesting a recommendation.");
    }
    return request;
  }

  const candidates = buildCompletedItemCandidates(candidateSource);
  if (candidates.length < 1) throw new RecommendationRequestError("No valid completed-item candidates are available.");
  return createItemRecommendationRequest(snapshot, candidates);
}

export async function runRecommendation(
  request: RecommendationRequest,
  provider: RecommendationProvider,
): Promise<RecommendationRun> {
  const prompt = buildRecommendationPrompt(request);
  const raw = await provider.generate(request, prompt);
  const validated = validateRecommendationResponse(raw, request);
  if (!validated.ok) throw new InvalidModelResponseError(validated.issues);
  return {
    request,
    prompt,
    recommendation: validated.value,
    provider: provider.metadata,
  };
}

