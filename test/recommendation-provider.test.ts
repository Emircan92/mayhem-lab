import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
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
