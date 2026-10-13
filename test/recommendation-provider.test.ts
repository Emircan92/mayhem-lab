import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import { APIConnectionError, APIConnectionTimeoutError, APIError, OpenAIError } from "openai/error";
import augments from "../data/generated/16.19.1/augments.json";
import champions from "../data/generated/16.19.1/champions.json";
import items from "../data/generated/16.19.1/items.json";
import manifest from "../data/generated/16.19.1/manifest.json";
import fixture from "../data/calibration/volibear-dropkick.json";
import type { Augment, Champion, Item } from "../lib/catalog";
import type { ManualGameState } from "../lib/game-state";
import {
  OpenAIRecommendationProvider, RecommendationProviderError, itemOutputTokenBudget,
  type CompletionRunner, type ProviderCompletion, type ProviderCompletionEvent,
} from "../lib/recommendation/provider";
import { createRecommendationRequest, InvalidModelResponseError, runRecommendation } from "../lib/recommendation/service";
import { buildRecommendationPrompt } from "../lib/recommendation/build-prompt";

const catalog = { champions: champions.champions as Champion[], augments: augments.augments as Augment[], items: items.items as Item[] };
const metadata = { patch: manifest.riotDataDragonPatch, generatedAt: manifest.generatedAt };
const state = fixture.request.state as ManualGameState;
const itemRequest = createRecommendationRequest("item", state, catalog, metadata, catalog.items);
const augmentRequest = createRecommendationRequest("augment", state, catalog, metadata, catalog.items);
const primary = itemRequest.kind === "item" ? itemRequest.candidateItems[0] : null;
const valid = {
  schemaVersion: 1, kind: "item", primary: { id: primary!.id, name: primary!.name, reason: "Grounded reason." },
  alternatives: [], buildDirection: null, warnings: [], confidence: "medium",
};
const exhausted: ProviderCompletion = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_parsed: null,
  usage: { input_tokens: 100, output_tokens: 8192, total_tokens: 8292, output_tokens_details: { reasoning_tokens: 8192 } } };
const completed: ProviderCompletion = { status: "completed", output_parsed: valid,
  usage: { input_tokens: 100, output_tokens: 150, total_tokens: 250,
    input_tokens_details: { cached_tokens: 50 }, output_tokens_details: { reasoning_tokens: 100 } } };

function harness(responses: Array<ProviderCompletion | Error>, budget: string | number = 8192) {
  const calls: Array<Parameters<CompletionRunner>> = [];
  const events: ProviderCompletionEvent[] = [];
  const provider = new OpenAIRecommendationProvider("offline-test-secret", "unchanged-configured-model", {
    itemMaxOutputTokens: budget, log: (event) => events.push(event),
    complete: async (...args) => {
      calls.push(args);
      const response = responses[calls.length - 1];
      assert.ok(response, "unexpected additional provider call");
      if (response instanceof Error) throw response;
      return response;
    },
  });
  return { provider, calls, events };
}

const sensitive = "offline-test-secret sensitive-content Volibear prompt headers body stack cause";
function sdkError(status: number, code: unknown = null, type: unknown = null) {
  return APIError.generate(status, { error: { message: sensitive, code, type, param: sensitive } }, undefined,
    new Headers({ "x-request-id": "req_Offline123", authorization: sensitive, "x-private": sensitive }));
}

test("provider catch diagnoses SDK failures without changing request errors or retry policy", async () => {
  const cases: Array<[Error, string, number | null, string | null, string | null]> = [
    [sdkError(400, "invalid_json_schema", "invalid_request_error"), "invalid-request", 400, "invalid_json_schema", "invalid_request_error"],
    [sdkError(422), "invalid-request", 422, null, null],
    [sdkError(401, "invalid_api_key", "invalid_request_error"), "authentication", 401, "invalid_api_key", "invalid_request_error"],
    [sdkError(429, "rate_limit_exceeded", "invalid_request_error"), "rate-limit", 429, "rate_limit_exceeded", "invalid_request_error"],
    [sdkError(429, "slow_down", "rate_limit_error"), "rate-limit", 429, "slow_down", "rate_limit_error"],
    [sdkError(429, null, "rate_limit_error"), "rate-limit", 429, null, "rate_limit_error"],
    [sdkError(429, "insufficient_quota"), "quota-exhaustion", 429, "insufficient_quota", null],
    [sdkError(429, null, "insufficient_quota"), "quota-exhaustion", 429, null, "insufficient_quota"],
    [sdkError(429, "project_spend_limit_exceeded", "insufficient_quota"), "quota-exhaustion", 429, "project_spend_limit_exceeded", "insufficient_quota"],
    [sdkError(429), "provider-http", 429, null, null],
    [sdkError(403), "provider-http", 403, null, null],
    [sdkError(404, "model_not_found", "invalid_request_error"), "provider-http", 404, "model_not_found", "invalid_request_error"],
    [sdkError(500, "server_error", "server_error"), "upstream-server", 500, "server_error", "server_error"],
    [sdkError(503, "server_is_overloaded", "service_unavailable_error"), "upstream-server", 503, "server_is_overloaded", "service_unavailable_error"],
    [new APIConnectionError({ message: sensitive, cause: new Error(sensitive) }), "connection", null, null, null],
    [new APIConnectionTimeoutError({ message: sensitive }), "connection", null, null, null],
    [new OpenAIError(sensitive), "sdk-error", null, null, null],
    [new Error(sensitive), "unknown-local", null, null, null],
  ];
  for (const [error, category, httpStatus, code, type] of cases) {
    const { provider, calls, events } = harness([error, completed]);
    await assert.rejects(runRecommendation(itemRequest, provider), (failure: unknown) =>
      failure instanceof RecommendationProviderError && failure.classification === "provider-request"
      && failure.message === "The model did not return a complete structured recommendation (provider-request)."
      && failure.cause === undefined);
    assert.equal(calls.length, 1);
    assert.equal(events[0].status, "request-error");
    assert.equal(events[0].classification, "provider-request");
    assert.deepEqual(events[0].errorDiagnostic, {
      category, httpStatus, code, type, requestId: error instanceof APIError && httpStatus !== null ? "req_Offline123" : null,
    });
    assert.doesNotMatch(JSON.stringify(events), /offline-test-secret|sensitive-content|Volibear|prompt|headers|body|stack|cause/);
  }
});

test("SDK diagnostics reject unknown and malformed fields without serializing their contents", async () => {
  const untrusted = { toJSON() { throw new Error("must never serialize SDK data"); },
    toString() { throw new Error("must never coerce SDK data"); } };
  for (const fields of [
    { code: sensitive, type: sensitive, requestID: sensitive },
    { code: "rate_limit_exceeded " + sensitive, type: "rate_limit_error\n" + sensitive, requestID: "req_Offline123\n" },
    { code: untrusted, type: untrusted, requestID: untrusted },
    { code: Symbol(sensitive), type: 42n, requestID: new String("req_Offline123") },
    { code: ["rate_limit_exceeded"], type: ["insufficient_quota"], requestID: "req_" },
    { requestID: "req_" + "A".repeat(129) },
    { requestID: "req_A\r" },
    { requestID: "req_A_B" },
    { requestID: "req_é" },
  ]) {
    const error = Object.assign(sdkError(429), fields);
    const { provider, events } = harness([error]);
    await assert.rejects(runRecommendation(itemRequest, provider), RecommendationProviderError);
    assert.deepEqual(events[0].errorDiagnostic, {
      category: "provider-http", httpStatus: 429, code: null, type: null, requestId: null,
    });
  }
  for (const status of ["401", 429.5, NaN, Infinity, 200, 600, untrusted, 429n, null, undefined]) {
    const { provider, events } = harness([Object.assign(sdkError(429), { status })]);
    await assert.rejects(runRecommendation(itemRequest, provider), RecommendationProviderError);
    assert.deepEqual(events[0].errorDiagnostic, {
      category: "sdk-error", httpStatus: null, code: null, type: null, requestId: "req_Offline123",
    });
  }
});

test("non-SDK thrown values cannot impersonate SDK errors or supply diagnostic fields", async () => {
  const forged = { name: "RateLimitError", status: 429, code: "insufficient_quota", type: "insufficient_quota",
    requestID: "req_Offline123", message: sensitive, cause: sensitive };
  for (const error of [null, undefined, 42, sensitive, forged, Object.assign(new Error(sensitive), forged)]) {
    const events: ProviderCompletionEvent[] = [];
    const provider = new OpenAIRecommendationProvider("offline-test-secret", "unchanged-configured-model", {
      itemMaxOutputTokens: 8192, log: (event) => events.push(event), complete: async () => { throw error; },
    });
    await assert.rejects(runRecommendation(itemRequest, provider), RecommendationProviderError);
    assert.deepEqual(events[0].errorDiagnostic, {
      category: "unknown-local", httpStatus: null, code: null, type: null, requestId: null,
    });
    assert.doesNotMatch(JSON.stringify(events), /offline-test-secret|sensitive-content|Volibear|RateLimitError/);
  }
});

test("SDK diagnostic fields are read once and throwing accessors do not replace the provider failure", async () => {
  const error = sdkError(429, null, "rate_limit_error");
  let reads = 0;
  Object.defineProperty(error, "code", { get: () => ++reads === 1 ? "rate_limit_exceeded" : sensitive });
  const { provider, events } = harness([error]);
  await assert.rejects(runRecommendation(itemRequest, provider), RecommendationProviderError);
  assert.equal(reads, 1);
  assert.equal(events[0].errorDiagnostic?.code, "rate_limit_exceeded");
  assert.doesNotMatch(JSON.stringify(events), /offline-test-secret|sensitive-content/);

  const malformed = sdkError(429);
  Object.defineProperty(malformed, "code", { get: () => { throw new Error(sensitive); } });
  const fallback = harness([malformed]);
  await assert.rejects(runRecommendation(itemRequest, fallback.provider), (failure: unknown) =>
    failure instanceof RecommendationProviderError && failure.classification === "provider-request");
  assert.deepEqual(fallback.events[0].errorDiagnostic, {
    category: "sdk-error", httpStatus: null, code: null, type: null, requestId: null,
  });
});

test("default provider logger emits JSON-serialized error diagnostics containing only safe fields", async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, "info", (...args: unknown[]) => { logs.push(args); });
  const error = Object.assign(sdkError(429, "insufficient_quota", "insufficient_quota"), {
    cause: new Error(sensitive), body: sensitive, prompt: sensitive, apiKey: sensitive,
    toJSON() { throw new Error("must never serialize the exception"); },
  });
  const provider = new OpenAIRecommendationProvider("offline-test-secret", "unchanged-configured-model", {
    itemMaxOutputTokens: 8192, complete: async () => { throw error; },
  });
  await assert.rejects(runRecommendation(itemRequest, provider), RecommendationProviderError);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].length, 2);
  assert.equal(logs[0][0], "Mayhem provider completion");
  assert.equal(typeof logs[0][1], "string");
  const serialized = logs[0][1] as string;
  assert.deepEqual(JSON.parse(serialized).errorDiagnostic, {
    category: "quota-exhaustion", httpStatus: 429, code: "insufficient_quota", type: "insufficient_quota", requestId: "req_Offline123",
  });
  assert.doesNotMatch(serialized, /offline-test-secret|sensitive-content|Volibear|prompt|headers|body|stack|cause|apiKey|message/);
});

test("item token exhaustion retries once with a larger bounded budget and succeeds through strict validation", async () => {
  const { provider, calls, events } = harness([exhausted, completed]);
  const result = await runRecommendation(itemRequest, provider);
  assert.equal(result.recommendation.primary.id, primary!.id);
  assert.deepEqual(calls.map(([parameters]) => parameters.max_output_tokens), [8192, 16384]);
  assert.deepEqual(calls.map(([, options]) => options), [{ maxRetries: 0, timeout: 120_000 }, { maxRetries: 0, timeout: 120_000 }]);
  assert.equal(calls[0][0].input, calls[1][0].input);
  for (const [parameters] of calls) {
    assert.equal(parameters.model, "unchanged-configured-model");
    assert.equal(parameters.store, false);
    assert.equal(parameters.text?.format?.type, "json_schema");
    assert.equal(parameters.text?.format?.strict, true);
    const input = JSON.parse(parameters.input as string);
    assert.equal(input.task.candidates.length, itemRequest.kind === "item" ? itemRequest.candidateItems.length : 0);
    if (itemRequest.kind === "item") for (const candidate of itemRequest.candidateItems) {
      assert.equal(input.task.candidates.find((item: { id: number }) => item.id === candidate.id).description, candidate.description);
    }
  }
  assert.deepEqual(events.map((event) => event.classification), ["token-exhaustion", "success"]);
  assert.equal(events[0].status, "incomplete");
  assert.equal(events[0].incompleteReason, "max_output_tokens");
  assert.equal(events[0].reasoningTokens, 8192);
  assert.equal(events[1].cachedInputTokens, 50);
  assert.equal(events[1].totalTokens, 250);
  assert.doesNotMatch(JSON.stringify(events), /offline-test-secret|Volibear|Grounded reason|candidateItems/);
});

test("actual SDK parser preserves incomplete status/usage on truncated JSON and validates the retry", async () => {
  let calls = 0;
  const events: ProviderCompletionEvent[] = [];
  const client = new OpenAI({ apiKey: "offline-sdk-secret", fetch: async () => {
    calls += 1;
    return new Response(JSON.stringify({
      id: "resp_offline", status: calls === 1 ? "incomplete" : "completed",
      incomplete_details: calls === 1 ? { reason: "max_output_tokens" } : null,
      usage: exhausted.usage,
      output: [{ type: "message", id: "msg_offline", role: "assistant", status: calls === 1 ? "incomplete" : "completed",
        content: [{ type: "output_text", text: calls === 1 ? '{"schemaVersion":1,"kind":' : JSON.stringify(valid), annotations: [] }] }],
    }), { headers: { "content-type": "application/json" } });
  } });
  const provider = new OpenAIRecommendationProvider("offline-sdk-secret", "unchanged-configured-model", {
    itemMaxOutputTokens: 8192, complete: (parameters, options) => client.responses.parse(parameters, options),
    log: (event) => events.push(event),
  });
  await runRecommendation(itemRequest, provider);
  assert.equal(calls, 2);
  assert.equal(events[0].classification, "token-exhaustion");
  assert.equal(events[0].outputTokens, 8192);
  assert.equal(events[1].status, "completed");
});

test("incomplete output is discarded even when a partial parsed object exists", async () => {
  const { provider, calls } = harness([{ status: "incomplete", output_parsed: valid }, completed]);
  await runRecommendation(itemRequest, provider);
  assert.equal(calls.length, 2);
});

test("retry exhaustion never makes a third call and respects the output-token ceiling", async () => {
  const { provider, calls, events } = harness([exhausted, exhausted, completed], 20000);
  await assert.rejects(runRecommendation(itemRequest, provider), (error: unknown) =>
    error instanceof RecommendationProviderError && error.classification === "token-exhaustion");
  assert.deepEqual(calls.map(([parameters]) => parameters.max_output_tokens), [20000, 32768]);
  assert.equal(events.length, 2);
});

test("augment requests retain 1200 tokens, existing SDK transport options, and no completion retry", async () => {
  const { provider, calls } = harness([exhausted, completed], "invalid item-only configuration");
  await assert.rejects(runRecommendation(augmentRequest, provider), RecommendationProviderError);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].max_output_tokens, 1200);
  assert.equal(calls[0][1], undefined);
});

test("refusals, content filters, invalid output, and transport errors are not completion-retried or logged verbatim", async () => {
  for (const [response, classification] of [
    [{ status: "incomplete", incomplete_details: { reason: "content_filter" } }, "content-filter"],
    [{ status: "incomplete", incomplete_details: { reason: "unknown-sensitive-reason" } }, "provider-request"],
    [{ status: "completed", output: [{ content: [{ type: "refusal", refusal: "sensitive-content" }] }] }, "refusal"],
    [{ status: "completed", output_parsed: null }, "invalid-structured-output"],
    [new SyntaxError("sensitive-content invalid JSON"), "invalid-structured-output"],
    [new Error("offline-test-secret sensitive-content request headers"), "provider-request"],
  ] as Array<[ProviderCompletion | Error, string]>) {
    const { provider, calls, events } = harness([response, completed]);
    await assert.rejects(runRecommendation(itemRequest, provider), (error: unknown) =>
      error instanceof RecommendationProviderError && error.classification === classification
      && !/sensitive-content|offline-test-secret/.test(error.message));
    assert.equal(calls.length, 1);
    assert.equal(events[0].classification, classification);
    assert.doesNotMatch(JSON.stringify(events), /sensitive-content|offline-test-secret|unknown-sensitive-reason/);
  }
});

test("successful completion does not bypass schema or candidate validation or retry an invalid recommendation", async () => {
  for (const invalid of [{ ...valid, primary: { ...valid.primary, id: 994403, name: "The Golden Spatula" } },
    { ...valid, confidence: "certain" }]) {
    const { provider, calls } = harness([{ status: "completed", output_parsed: invalid }, completed]);
    await assert.rejects(runRecommendation(itemRequest, provider), InvalidModelResponseError);
    assert.equal(calls.length, 1);
  }
});

test("item output budget configuration defaults, validates bounds, and controls actual requests", async () => {
  assert.equal(itemOutputTokenBudget(undefined), 8192);
  assert.equal(itemOutputTokenBudget(""), 8192);
  assert.equal(itemOutputTokenBudget("1201"), 1201);
  assert.equal(itemOutputTokenBudget("32768"), 32768);
  for (const value of ["1200", "0", "-1", "1.5", "1e4", "NaN", "32769", "secret-value"]) {
    assert.throws(() => itemOutputTokenBudget(value), (error: unknown) =>
      error instanceof RecommendationProviderError && error.classification === "configuration"
      && !error.message.includes("secret-value"));
  }
  const { provider, calls } = harness([completed], "10000");
  await runRecommendation(itemRequest, provider);
  assert.equal(calls[0][0].max_output_tokens, 10000);
  const bad = harness([completed], "bad");
  await assert.rejects(bad.provider.generate(itemRequest, buildRecommendationPrompt(itemRequest)), RecommendationProviderError);
  assert.equal(bad.calls.length, 0);
});

test("item budget environment configuration reaches provider calls without changing the model", async () => {
  const previous = process.env.MAYHEM_ITEM_MAX_OUTPUT_TOKENS;
  try {
    process.env.MAYHEM_ITEM_MAX_OUTPUT_TOKENS = "12000";
    let parameters: Parameters<CompletionRunner>[0] | undefined;
    const provider = new OpenAIRecommendationProvider("offline-env-secret", "unchanged-configured-model", {
      log: () => {}, complete: async (body) => { parameters = body; return completed; },
    });
    await runRecommendation(itemRequest, provider);
    assert.equal(parameters!.max_output_tokens, 12000);
    assert.equal(parameters!.model, "unchanged-configured-model");
  } finally {
    if (previous === undefined) delete process.env.MAYHEM_ITEM_MAX_OUTPUT_TOKENS;
    else process.env.MAYHEM_ITEM_MAX_OUTPUT_TOKENS = previous;
  }
});
