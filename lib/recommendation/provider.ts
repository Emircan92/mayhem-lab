import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import type { RecommendationRequest } from "../recommendation-contract";
import type { RecommendationPrompt } from "./build-prompt";
import { modelRecommendationSchema } from "./response-schema";

export type ProviderMetadata = {
  provider: "openai" | "fake";
  model: string;
};

export interface RecommendationProvider {
  readonly metadata: ProviderMetadata;
  generate(request: RecommendationRequest, prompt: RecommendationPrompt): Promise<unknown>;
}

export class RecommendationProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecommendationProviderError";
  }
}

export class OpenAIRecommendationProvider implements RecommendationProvider {
  readonly metadata: ProviderMetadata;
  private readonly client: OpenAI;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.metadata = { provider: "openai", model };
  }

  async generate(_request: RecommendationRequest, prompt: RecommendationPrompt): Promise<unknown> {
    const response = await this.client.responses.parse({
      model: this.metadata.model,
      instructions: prompt.instructions,
      input: prompt.input,
      max_output_tokens: 1200,
      store: false,
      text: {
        format: zodTextFormat(modelRecommendationSchema, "mayhem_recommendation"),
      },
    });

    if (!response.output_parsed) {
      const detail = response.incomplete_details?.reason
        ? ` (${response.incomplete_details.reason})`
        : "";
      throw new RecommendationProviderError(`The model did not return a complete structured recommendation${detail}.`);
    }
    return response.output_parsed;
  }
}

export class FakeRecommendationProvider implements RecommendationProvider {
  readonly metadata: ProviderMetadata = { provider: "fake", model: "deterministic-development-fake" };

  async generate(request: RecommendationRequest): Promise<unknown> {
    const candidates = request.kind === "augment"
      ? request.snapshot.offeredAugments
          .filter((candidate) => candidate !== null)
          .map((candidate) => ({ id: candidate.id, name: candidate.name }))
      : request.candidateItems.map((candidate) => ({ id: candidate.id, name: candidate.name }));
    const [primary, ...alternatives] = candidates;
    if (!primary) throw new RecommendationProviderError("The development fake received no candidates.");

    return {
      schemaVersion: 1,
      kind: request.kind,
      primary: {
        ...primary,
        reason: "Development fake selected the first valid candidate; this is not strategic advice.",
      },
      alternatives: alternatives.slice(0, 2).map((candidate) => ({
        ...candidate,
        reason: "Development fake alternative from the supplied candidate set.",
        preferWhen: null,
      })),
      buildDirection: null,
      warnings: ["Development fake provider is active; configure OpenAI for a real recommendation."],
      confidence: "low",
    };
  }
}

export function configuredRecommendationProvider(): RecommendationProvider {
  if (process.env.MAYHEM_RECOMMENDATION_PROVIDER === "fake") {
    if (process.env.NODE_ENV === "production") {
      throw new RecommendationProviderError("The fake recommendation provider is disabled in production.");
    }
    return new FakeRecommendationProvider();
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_MODEL?.trim();
  if (!apiKey || !model) {
    throw new RecommendationProviderError(
      "Recommendation provider is not configured. Set OPENAI_API_KEY and OPENAI_MODEL.",
    );
  }
  return new OpenAIRecommendationProvider(apiKey, model);
}

