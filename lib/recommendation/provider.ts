import OpenAI from "openai";
import { APIConnectionError, APIError, LengthFinishReasonError, OpenAIError } from "openai/error";
import { zodTextFormat } from "openai/helpers/zod";
import { ZodError } from "zod";

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

export type ProviderFailureClassification = "token-exhaustion" | "incomplete-output" | "content-filter"
  | "refusal" | "invalid-structured-output" | "provider-request" | "configuration";

export class RecommendationProviderError extends Error {
  constructor(message: string, readonly classification: ProviderFailureClassification = "provider-request") {
    super(message);
    this.name = "RecommendationProviderError";
  }
}

const AUGMENT_MAX_OUTPUT_TOKENS = 1200;
const DEFAULT_ITEM_MAX_OUTPUT_TOKENS = 8192;
const ITEM_TOKEN_CEILING = 32768;

export function itemOutputTokenBudget(value: string | number | undefined): number {
  if (value === undefined || value === "") return DEFAULT_ITEM_MAX_OUTPUT_TOKENS;
  const budget = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(budget)
    || budget <= AUGMENT_MAX_OUTPUT_TOKENS || budget > ITEM_TOKEN_CEILING) {
    throw new RecommendationProviderError(
      "Item recommendation output-token budget is not configured correctly. MAYHEM_ITEM_MAX_OUTPUT_TOKENS must be an integer from 1201 to 32768.",
      "configuration",
    );
  }
  return budget;
}

// Narrow transport seam keeps tests offline, while production still uses the SDK's strict parser.
export type ProviderCompletion = {
  status?: string | null;
  output_parsed?: unknown;
  incomplete_details?: { reason?: string | null } | null;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } } | null;
  output?: unknown;
};
type CompletionParameters = Parameters<OpenAI["responses"]["parse"]>[0];
type CompletionOptions = { maxRetries: number; timeout: number };
export type CompletionRunner = (parameters: CompletionParameters, options?: CompletionOptions) => Promise<ProviderCompletion>;
type ProviderErrorDiagnostic = {
  category: "rate-limit" | "quota-exhaustion" | "authentication" | "invalid-request" | "connection"
    | "upstream-server" | "provider-http" | "sdk-error" | "unknown-local" | "token-exhaustion" | "invalid-structured-output";
  httpStatus: number | null;
  code: string | null;
  type: string | null;
  requestId: string | null;
};

function providerErrorDiagnostic(error: unknown): ProviderErrorDiagnostic {
  const diagnostic: ProviderErrorDiagnostic = {
    category: error instanceof LengthFinishReasonError ? "token-exhaustion"
      : error instanceof SyntaxError || error instanceof ZodError ? "invalid-structured-output"
      : error instanceof APIConnectionError ? "connection" : error instanceof OpenAIError ? "sdk-error" : "unknown-local",
    httpStatus: null, code: null, type: null, requestId: null,
  };
  if (!(error instanceof APIError)) return diagnostic;
  let status: unknown, code: unknown, type: unknown, requestID: unknown;
  try {
    ({ status, code, type, requestID } = error);
  } catch {
    return diagnostic;
  }

  // Never copy arbitrary SDK fields: even codes and request IDs are untrusted strings.
  const quotaCodes = ["insufficient_quota", "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded", "organization_usage_limit_exceeded"];
  const codes = [...quotaCodes, "rate_limit_exceeded", "slow_down", "invalid_api_key", "invalid_request",
    "invalid_json_schema", "model_not_found", "context_length_exceeded", "server_error", "server_is_overloaded"];
  const types = ["insufficient_quota", "rate_limit_error", "authentication_error", "invalid_request_error",
    "server_error", "service_unavailable_error"];
  diagnostic.httpStatus = typeof status === "number" && Number.isInteger(status)
    && status >= 400 && status <= 599 ? status : null;
  diagnostic.code = typeof code === "string" && codes.includes(code) ? code : null;
  diagnostic.type = typeof type === "string" && types.includes(type) ? type : null;
  const id = requestID;
  diagnostic.requestId = typeof id === "string" && id.startsWith("req_") && id.length > 4 && id.length <= 132
    && !/[^A-Za-z0-9]/.test(id.slice(4)) ? id : null;
  const httpStatus = diagnostic.httpStatus;
  diagnostic.category = error instanceof APIConnectionError ? "connection"
    : httpStatus === 429 && (quotaCodes.includes(diagnostic.code ?? "") || diagnostic.type === "insufficient_quota") ? "quota-exhaustion"
    : httpStatus === 429 && (diagnostic.code === "rate_limit_exceeded" || diagnostic.code === "slow_down"
      || diagnostic.type === "rate_limit_error") ? "rate-limit"
    : httpStatus === 401 ? "authentication"
    : httpStatus === 400 || httpStatus === 422 ? "invalid-request"
    : httpStatus !== null && httpStatus >= 500 ? "upstream-server"
    : httpStatus !== null ? "provider-http" : "sdk-error";
  return diagnostic;
}

export type ProviderCompletionEvent = {
  event: "mayhem-recommendation-provider";
  kind: "item" | "augment";
  model: string;
  attempt: number;
  maxOutputTokens: number;
  status: string;
  incompleteReason: "max_output_tokens" | "content_filter" | "other" | null;
  classification: ProviderFailureClassification | "success";
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  elapsedMs: number;
  errorDiagnostic?: ProviderErrorDiagnostic;
};
type ProviderOptions = {
  itemMaxOutputTokens?: number | string;
  complete?: CompletionRunner;
  log?: (event: ProviderCompletionEvent) => void;
};

function completionFailure(response: ProviderCompletion): ProviderFailureClassification | null {
  if (response.status === "incomplete") {
    if (response.incomplete_details?.reason === "max_output_tokens") return "token-exhaustion";
    if (response.incomplete_details?.reason === "content_filter") return "content-filter";
    if (!response.incomplete_details?.reason) return "incomplete-output";
    return "provider-request";
  }
  const refused = Array.isArray(response.output) && response.output.some((item) =>
    Array.isArray(item?.content) && item.content.some((content: { type?: string }) => content.type === "refusal"));
  if (refused) return "refusal";
  if (response.status === "completed" && response.output_parsed != null) return null;
  return response.status === "completed" ? "invalid-structured-output" : "provider-request";
}

function tokenCount(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : null;
}

export class OpenAIRecommendationProvider implements RecommendationProvider {
  readonly metadata: ProviderMetadata;
  private readonly complete: CompletionRunner;
  private readonly log: (event: ProviderCompletionEvent) => void;
  private readonly itemBudget: string | number | undefined;

  constructor(apiKey: string, model: string, options: ProviderOptions = {}) {
    const client = new OpenAI({ apiKey });
    this.complete = options.complete ?? ((parameters, requestOptions) => client.responses.parse(parameters, requestOptions));
    this.log = options.log ?? ((event) => console.info("Mayhem provider completion", event.errorDiagnostic ? JSON.stringify(event) : event));
    this.itemBudget = options.itemMaxOutputTokens ?? process.env.MAYHEM_ITEM_MAX_OUTPUT_TOKENS;
    this.metadata = { provider: "openai", model };
  }

  async generate(request: RecommendationRequest, prompt: RecommendationPrompt): Promise<unknown> {
    const initialBudget = request.kind === "item" ? itemOutputTokenBudget(this.itemBudget) : AUGMENT_MAX_OUTPUT_TOKENS;
    const attempts = request.kind === "item" ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const budget = attempt === 1 ? initialBudget : Math.min(initialBudget * 2, ITEM_TOKEN_CEILING);
      const started = Date.now();
      let response: ProviderCompletion | undefined;
      let classification: ProviderFailureClassification | null;
      let errorDiagnostic: ProviderErrorDiagnostic | undefined;
      try {
        response = await this.complete({
          model: this.metadata.model,
          instructions: prompt.instructions,
          input: prompt.input,
          max_output_tokens: budget,
          store: false,
          text: { format: zodTextFormat(modelRecommendationSchema, "mayhem_recommendation") },
        }, request.kind === "item" ? { maxRetries: 0, timeout: 120_000 } : undefined);
        classification = completionFailure(response);
      } catch (error) {
        errorDiagnostic = providerErrorDiagnostic(error);
        classification = error instanceof LengthFinishReasonError ? "token-exhaustion"
          : error instanceof SyntaxError || error instanceof ZodError ? "invalid-structured-output" : "provider-request";
      }
      const reason = response?.incomplete_details?.reason;
      this.log({
        event: "mayhem-recommendation-provider", kind: request.kind, model: this.metadata.model,
        attempt, maxOutputTokens: budget,
        status: ["completed", "incomplete", "failed", "cancelled", "queued", "in_progress"].includes(response?.status ?? "")
          ? response!.status! : response ? "unknown" : classification === "invalid-structured-output" ? "parse-error" : "request-error",
        incompleteReason: reason === "max_output_tokens" || reason === "content_filter" ? reason : reason ? "other" : null,
        classification: classification ?? "success",
        inputTokens: tokenCount(response?.usage?.input_tokens), outputTokens: tokenCount(response?.usage?.output_tokens),
        reasoningTokens: tokenCount(response?.usage?.output_tokens_details?.reasoning_tokens),
        cachedInputTokens: tokenCount(response?.usage?.input_tokens_details?.cached_tokens),
        totalTokens: tokenCount(response?.usage?.total_tokens), elapsedMs: Date.now() - started,
        ...(errorDiagnostic ? { errorDiagnostic } : {}),
      });
      if (classification === null) return response!.output_parsed;
      if (attempt < attempts && (classification === "token-exhaustion" || classification === "incomplete-output")) continue;
      throw new RecommendationProviderError(
        `The model did not return a complete structured recommendation (${classification}).`, classification,
      );
    }
    throw new RecommendationProviderError("The recommendation provider request failed.");
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

