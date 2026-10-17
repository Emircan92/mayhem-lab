import assert from "node:assert/strict";
import test from "node:test";

import fixture from "../data/calibration/strategic-foresight.json";
import augments from "../data/generated/16.19.1/augments.json";
import champions from "../data/generated/16.19.1/champions.json";
import items from "../data/generated/16.19.1/items.json";
import manifest from "../data/generated/16.19.1/manifest.json";
import type { Augment, Champion, Item } from "../lib/catalog";
import { SessionRecorder } from "../lib/diagnostics/recorder";
import { requestEvidenceSchema } from "../lib/diagnostics/schema";
import { recommendationApiInputSchema } from "../lib/recommendation/api-contract";
import { buildRecommendationPrompt } from "../lib/recommendation/build-prompt";
import { OpenAIRecommendationProvider, type RecommendationProvider } from "../lib/recommendation/provider";
import { RecommendationRequestLifecycle, recommendationContext } from "../lib/recommendation/request-lifecycle";
import { createRecommendationRequest, runRecommendation } from "../lib/recommendation/service";
import { validateRecommendationResponse } from "../lib/recommendation/validate-response";

const catalog = { champions: champions.champions as Champion[], augments: augments.augments as Augment[], items: items.items as Item[] };
const metadata = { patch: manifest.riotDataDragonPatch, generatedAt: manifest.generatedAt };
function prepare(entry = fixture.cases[0]) {
  const input = recommendationApiInputSchema.parse(entry.request);
  const request = createRecommendationRequest(input.kind, input.state, catalog, metadata, catalog.items);
  assert.equal(request.kind, "augment");
  if (request.kind !== "augment") throw new Error("Expected augment fixture");
  return { input, request, prompt: buildRecommendationPrompt(request) };
}

// These tests verify supplied evidence, evaluation guidance and response boundaries.
// The reviewCriteria in the fixtures require real-model/manual calibration.
test("all foresight cases resolve pinned facts and keep authored examples inside the existing contract", () => {
  assert.equal(fixture.patch, metadata.patch);
  for (const entry of fixture.cases) {
    const { input, request, prompt } = prepare(entry);
    const parsed = JSON.parse(prompt.input);
    assert.deepEqual(request.candidateAugmentIds, input.state.offeredAugments.filter((a) => a !== null).map((a) => a.augmentId));
    assert.deepEqual(parsed.constraints.allowedCandidateIds, request.candidateAugmentIds);
    assert.deepEqual(parsed.task.candidates, request.snapshot.offeredAugments.filter((a) => a !== null));
    assert.ok(request.snapshot.champion?.kit.q.description);
    assert.ok(request.snapshot.enemies.every((enemy) => enemy.kit.r.description));
    assert.equal(validateRecommendationResponse(entry.illustrativeResponse, request).ok, true, entry.id);
    assert.ok(entry.reviewCriteria.length >= 4);
    // Reviewer's scenario labels and illustrative choice must not bias the request.
    assert.equal(prompt.input.includes(entry.name), false);
    assert.equal(prompt.input.includes(entry.illustrativeResponse.primary.reason), false);
  }
});

test("zero-AP Karthus comparison includes conditional growth and meaningful ultimate/basic tradeoffs", () => {
  const { request, prompt } = prepare();
  const evaluation = JSON.parse(prompt.input).task.evaluation;
  assert.equal(request.snapshot.champion?.name, "Karthus");
  assert.equal(request.snapshot.stats.abilityPower?.value, 0);
  assert.equal(request.snapshot.items.length, 0);
  assert.deepEqual(request.candidateAugmentIds, [1030, 1349]);
  assert.equal(request.snapshot.offeredAugments[0]?.description, "Gain Ability Haste equal to 30% Ability Power.");
  assert.match(evaluation.horizons.immediate, /current items and reported stats/);
  assert.match(evaluation.horizons.midgame, /next plausible purchases/);
  assert.match(evaluation.horizons.lateGame, /conditionally.*not guaranteed/);
  assert.match(evaluation.practicalValue, /ultimate uptime separately from basic-ability throughput/);
  assert.match(evaluation.practicalValue, /cast cadence, toggles, channels, resources/);
  assert.match(evaluation.opportunityCost, /passing.*comes online too late/);
  assert.match(evaluation.opportunityCost, /currently low or zero/);
  assert.match(evaluation.grounding, /factual scaling.*conditional assumptions/);
  assert.match(evaluation.grounding, /exact cooldowns.*missing numerical augment effects/);
  assert.match(evaluation.response, /preferWhen.*reverse the choice/);
  // Neither a future full build nor invented Ultimate Awakening values are supplied.
  assert.equal(request.snapshot.offeredAugments[1]?.description.includes("temporarily"), true);
  assert.equal(/\d/.test(request.snapshot.offeredAugments[1]!.description), false);
});

test("established AP/haste and owned scaling reach the prompt unchanged without a universal ranking", () => {
  const { request, prompt } = prepare(fixture.cases[1]);
  assert.equal(request.snapshot.stats.abilityPower?.value, 600);
  assert.equal(request.snapshot.stats.abilityHaste?.value, 200);
  assert.deepEqual(request.snapshot.ownedAugments.map((a) => a.name), ["Phenomenal Evil", "ADAPt"]);
  const parsed = JSON.parse(prompt.input);
  assert.equal(parsed.facts.normalizedState.stats.abilityPower.value, 600, "do not add item AP to reported AP");
  assert.match(parsed.task.evaluation.buildDirection, /owned augments and items/);
  assert.match(parsed.task.evaluation.practicalValue, /existing haste and diminishing practical returns/);
  // Guidance is shared across champions; names/formulas are only supplied catalog evidence.
  const other = prepare(fixture.cases[2]);
  assert.deepEqual(parsed.task.evaluation, JSON.parse(other.prompt.input).task.evaluation);
  assert.equal(other.request.snapshot.champion?.name, "Vayne");
  assert.equal(other.request.snapshot.items.length, 6);
  assert.ok(other.request.snapshot.facts.some((fact) => fact.kind === "stat-cap"));
  assert.match(other.request.snapshot.champion!.kit.r.description, /reduced Tumble cooldown/);
});

test("unknown AP stays unknown and unresolved numerical offers retain their grounding warnings", () => {
  const { request, prompt } = prepare(fixture.cases[3]);
  assert.equal(request.snapshot.stats.abilityPower, undefined);
  assert.equal(JSON.parse(prompt.input).facts.normalizedState.stats.abilityPower, undefined);
  assert.equal(request.snapshot.items[0].name, "Blasting Wand");
  assert.deepEqual(request.snapshot.offeredAugments[2]?.unresolvedTokens, ["@AP@"]);
  assert.ok(request.snapshot.warnings.some((warning) => warning.kind === "augment-description-missing-detail"));
  assert.match(JSON.parse(prompt.input).task.evaluation.horizons.immediate, /missing stats are unknown, not zero/);
  assert.equal(JSON.parse(prompt.input).facts.dataQuality.missingDetailAugmentIds.includes(1097), true);
});

test("foresight does not bypass structured validation, grounding or situational alternatives", async () => {
  const entry = fixture.cases[0];
  const { request, prompt } = prepare(entry);
  let calls = 0;
  const provider: RecommendationProvider = {
    metadata: { provider: "fake", model: "authored-fixture-only" },
    async generate(received, receivedPrompt) {
      calls++;
      assert.deepEqual(received, request);
      assert.deepEqual(receivedPrompt, prompt);
      return entry.illustrativeResponse;
    },
  };
  const run = await runRecommendation(request, provider);
  assert.equal(calls, 1);
  assert.equal(run.recommendation.alternatives[0].preferWhen, entry.illustrativeResponse.alternatives[0].preferWhen);
  // Both offered winners remain legal; the evaluation rubric does not prescribe one.
  assert.equal(validateRecommendationResponse({ ...entry.illustrativeResponse,
    primary: entry.illustrativeResponse.alternatives[0], alternatives: [] }, request).ok, true);
  for (const update of [
    { primary: { id: 999, name: "Invented", reason: "Scaling" } },
    { primary: { id: 1030, name: "Incorrect name", reason: "Scaling" } },
    { alternatives: [{ id: 1030, name: "Eureka", reason: "Duplicate", preferWhen: null }] },
    { primary: { id: 1030, name: "Eureka", reason: "" } },
    { kind: "item" },
  ]) assert.equal(validateRecommendationResponse({ ...entry.illustrativeResponse, ...update }, request).ok, false);
});

test("augment provider still uses one completion, the configured model, 1200 tokens and existing transport behavior", async () => {
  const { request, prompt } = prepare();
  let calls = 0;
  const provider = new OpenAIRecommendationProvider("not-a-real-key", "preserved-model", {
    log: () => {},
    complete: async (parameters, options) => {
      calls++;
      assert.equal(parameters.model, "preserved-model");
      assert.equal(parameters.max_output_tokens, 1200);
      assert.equal(parameters.store, false);
      assert.equal(options, undefined);
      assert.equal(parameters.input, prompt.input);
      return { status: "completed", output_parsed: fixture.cases[0].illustrativeResponse };
    },
  });
  await runRecommendation(request, provider);
  assert.equal(calls, 1);
});

test("existing next-item task is unaffected by the augment-only evaluation", () => {
  const { input } = prepare();
  const request = createRecommendationRequest("item", input.state, catalog, metadata, catalog.items);
  const task = JSON.parse(buildRecommendationPrompt(request).input).task;
  assert.equal(task.objective, "Recommend the next completed item.");
  assert.equal(task.evaluation, undefined);
  assert.equal(task.candidates.length, 105);
});

test("foresight results remain correlated in diagnostics V1 and display as outdated after a build edit", async () => {
  const { input, request } = prepare();
  const validated = validateRecommendationResponse(fixture.cases[0].illustrativeResponse, request);
  assert.ok(validated.ok);
  const recorder = new SessionRecorder({ clock: () => 100_000 });
  recorder.start(input.state, metadata);
  const id = recorder.requested("augment")!;
  recorder.submitted(id, input.state);
  const context = (state = input.state) => recommendationContext(state, { enabled: false, boundary: 0, status: "waiting", snapshot: null, candidate: null }, 0, 0, 100_000);
  const lifecycle = new RecommendationRequestLifecycle();
  const token = lifecycle.start("augment", context())!;
  lifecycle.submit(token, context(), input.state);
  recorder.completed(id, {
    ok: true, recommendation: validated.value,
    diagnostics: { requestId: id, outcome: "success", elapsedMs: 50, attempts: [], evidence: requestEvidenceSchema.parse(request) },
  }, 200, 75);
  const freshness = lifecycle.assess(token, context({ ...input.state, itemIds: [1058] }));
  assert.equal(freshness.status, "outdated");
  recorder.disposition(id, "displayed", { phase: "response", freshness: freshness.status, cause: freshness.reason, fields: freshness.fields });
  lifecycle.finish(token);
  const bundle = recorder.exportBundle()!;
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.recommendations[0].requestId, id);
  assert.deepEqual(bundle.recommendations[0].result, validated.value);
  assert.deepEqual(bundle.recommendations[0].candidateAugmentIds, [1030, 1349]);
  assert.equal(bundle.summary.staleResults, 0);
  assert.equal(bundle.recommendations[0].disposition, "displayed");
  assert.equal(bundle.events.at(-1)!.data.lifecycle!.freshness, "outdated");
  assert.equal(bundle.droppedEvents, 0);
  recorder.discard();
});
