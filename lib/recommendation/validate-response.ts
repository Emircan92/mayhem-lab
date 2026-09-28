import type {
  RecommendationRequest,
  RecommendationResponse,
} from "../recommendation-contract";
import { modelRecommendationSchema } from "./response-schema";

export type RecommendationValidationResult =
  | { ok: true; value: RecommendationResponse }
  | { ok: false; issues: string[] };

function candidateNames(request: RecommendationRequest): Map<number, string> {
  if (request.kind === "item") {
    return new Map(request.candidateItems.map((candidate) => [candidate.id, candidate.name]));
  }
  return new Map(
    request.snapshot.offeredAugments
      .filter((candidate) => candidate !== null)
      .map((candidate) => [candidate.id, candidate.name]),
  );
}

export function validateRecommendationResponse(
  raw: unknown,
  request: RecommendationRequest,
): RecommendationValidationResult {
  const parsed = modelRecommendationSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`),
    };
  }

  const response = parsed.data;
  const issues: string[] = [];
  const candidates = candidateNames(request);
  const suppliedIds = request.kind === "augment"
    ? new Set(request.candidateAugmentIds)
    : new Set(request.candidateItems.map((candidate) => candidate.id));

  if (response.kind !== request.kind) {
    issues.push(`Expected a ${request.kind} response, received ${response.kind}.`);
  }

  const choices = [response.primary, ...response.alternatives];
  for (const choice of choices) {
    if (!suppliedIds.has(choice.id)) issues.push(`Choice ID ${choice.id} is not in the supplied candidate set.`);
    const canonicalName = candidates.get(choice.id);
    if (canonicalName && choice.name !== canonicalName) {
      issues.push(`Choice ID ${choice.id} must use catalog name "${canonicalName}".`);
    }
  }

  const choiceIds = choices.map((choice) => choice.id);
  if (new Set(choiceIds).size !== choiceIds.length) issues.push("Primary and alternative IDs must be unique.");

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      kind: request.kind,
      primary: response.primary,
      alternatives: response.alternatives.map(({ preferWhen, ...choice }) => ({
        ...choice,
        ...(preferWhen ? { preferWhen } : {}),
      })),
      ...(response.buildDirection ? { buildDirection: response.buildDirection } : {}),
      warnings: response.warnings,
      confidence: response.confidence,
    },
  };
}

