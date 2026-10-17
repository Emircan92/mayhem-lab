import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { SessionRecorder, RECORDING_KEY, LIMITS } from "../lib/diagnostics/recorder";
import { attemptSchema, bundleSchema, eventSchema, requestEvidenceSchema, type ServerDiagnostics } from "../lib/diagnostics/schema";
import { createEmptyGameState, recordOfferedAugment, type ManualGameState } from "../lib/game-state";
import { normalizeLiveState, LiveDataError } from "../lib/live-client/normalize";
import { createRecommendationRequest } from "../lib/recommendation/service";
import { FakeRecommendationProvider, OpenAIRecommendationProvider, type ProviderCompletionEvent } from "../lib/recommendation/provider";
import { runRecommendation } from "../lib/recommendation/service";
import { POST } from "../app/api/recommend/route";
import { buildRecommendationPrompt } from "../lib/recommendation/build-prompt";
import augments from "../data/generated/16.19.1/augments.json";
import champions from "../data/generated/16.19.1/champions.json";
import items from "../data/generated/16.19.1/items.json";
import manifest from "../data/generated/16.19.1/manifest.json";
import fixture from "../data/calibration/volibear-dropkick.json";
import type { Augment, Champion, Item } from "../lib/catalog";

const data = { patch: manifest.riotDataDragonPatch, generatedAt: manifest.generatedAt };
const catalog = { champions: champions.champions as Champion[], augments: augments.augments as Augment[], items: items.items as Item[] };
const state = fixture.request.state as ManualGameState;
const request = createRecommendationRequest("item", state, catalog, data, catalog.items);
const run = await runRecommendation(request, new FakeRecommendationProvider());
function harness() {
  let now = 100_000, writes = 0;
  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { writes++; entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
  const recorder = new SessionRecorder({ storage, clock: () => now });
  return { recorder, storage, entries, tick: (ms = 100) => { now += ms; }, writes: () => writes };
}
const completion = (requestId: string, attempts: ProviderCompletionEvent[] = []) => ({ ok: true, recommendation: run.recommendation,
  diagnostics: { requestId, elapsedMs: 900, attempts: attempts.map((a) => attemptSchema.parse(a)), outcome: "success", provider: run.provider,
    evidence: requestEvidenceSchema.parse(request) } satisfies ServerDiagnostics });
function liveFixture() {
  const selected = catalog.champions.slice(0, 10);
  return { activePlayer: { riotId: "PRIVATE#ID", championStats: { attackDamage: 100, attackSpeed: 1.5, abilityPower: 10, armor: 50, magicResist: 40, abilityHaste: 20, maxHealth: 1000 } },
    players: selected.map((c, i) => ({ riotId: i ? `PRIVATE${i}#ID` : "PRIVATE#ID", rawChampionName: `game_character_displayname_${c.key}`,
      team: i < 5 ? "ORDER" : "CHAOS", items: [] })), game: { gameTime: 120, gameMode: "ARAM", mapNumber: 12 } };
}

test("start, stop, export, discard, ordering and independent New Game identifiers", () => {
  const h = harness(), r = h.recorder;
  assert.equal(r.exportBundle(), null);
  r.start(state, data); h.tick();
  const initial = r.exportBundle()!;
  r.newGame(); h.tick(); r.stop();
  const b = r.exportBundle()!;
  assert.equal(bundleSchema.safeParse(b).success, true);
  assert.equal(b.schemaVersion, 1); assert.equal(b.active, false); assert.ok(b.endedAt);
  assert.equal(b.sessionId, initial.sessionId); assert.notEqual(b.gameId, initial.gameId);
  assert.deepEqual(b.events.map((e) => e.type), ["session-started", "new-game", "session-stopped"]);
  assert.deepEqual(b.events.map((e) => e.seq), [1, 2, 3]);
  assert.ok(b.events.every((e, i) => !i || e.at >= b.events[i - 1].at));
  r.event("new-game"); assert.equal(r.exportBundle()!.events.length, 3);
  r.start(state, data); assert.equal(r.exportBundle()!.sessionId, initial.sessionId);
  r.discard(); assert.equal(r.hasRecording, false); assert.equal(h.entries.has(RECORDING_KEY), false);
});

test("refresh recovers active recording and classifies pending work without resubmitting", () => {
  const h = harness(); h.recorder.start(state, data);
  const id = h.recorder.requested("item")!; h.recorder.submitted(id, state); h.recorder.flush();
  const fresh = new SessionRecorder({ clock: () => 101_000 }); fresh.recover(h.storage);
  const b = fresh.exportBundle()!;
  assert.ok(fresh.active); assert.equal(b.recommendations[0].requestId, id);
  assert.equal(b.recommendations[0].outcome, "interrupted");
  assert.equal(b.recommendations[0].category, "response-lost-on-refresh");
  assert.ok(b.events.some((e) => e.type === "refresh-recovered"));
  fresh.stop(); const completed = new SessionRecorder(); completed.recover(h.storage);
  assert.equal(completed.active, false); assert.ok(completed.exportBundle()!.endedAt);
  completed.discard(); h.recorder.discard();
});

test("offer slots, inferred replacements, ability edits and eventual owned pick remain chronological", () => {
  const h = harness(), r = h.recorder, empty = createEmptyGameState(); r.start(empty, data);
  const offers: ManualGameState = { ...empty, offeredAugments: [{ augmentId: 1 }, { augmentId: 2 }, { augmentId: 3 }] };
  r.observeManual(empty, offers);
  const replaced: ManualGameState = { ...offers, offeredAugments: [offers.offeredAugments[0], { augmentId: 4, abilityContext: "Q" }, offers.offeredAugments[2]] };
  r.observeManual(offers, replaced);
  const chosen = recordOfferedAugment(replaced, 1); r.observeManual(replaced, chosen);
  const b = r.exportBundle()!, changes = b.events.filter((e) => e.type === "offer-slot-changed");
  assert.deepEqual(changes.slice(0, 3).map((e) => e.data.slot), [1, 2, 3]);
  assert.equal(b.summary.offerReplacements, 1); assert.equal(b.summary.ownedSelections, 1);
  assert.deepEqual(b.events.find((e) => e.type === "augment-owned")!.data.augment, { augmentId: 4, abilityContext: "Q" });
  assert.equal(b.events.find((e) => e.type === "inferred-offer-replacement")!.source, "app-inference");
  const edited = { ...chosen, ownedAugments: [{ augmentId: 4, abilityContext: "W" }] };
  r.observeManual(chosen, edited); r.observeManual(edited, empty);
  assert.ok(r.exportBundle()!.events.some((e) => e.type === "ability-context-changed"));
  assert.ok(r.exportBundle()!.events.some((e) => e.type === "augment-removed")); r.discard();
});

test("results correlate, retain authoritative evidence, deduplicate catalogs and record stale/failed/displayed outcomes", () => {
  const h = harness(), r = h.recorder; r.start(state, data);
  const one = r.requested("item")!; r.submitted(one, state); h.tick(1200);
  r.completed(one, completion(one), 200, 1200); r.disposition(one, "displayed");
  const two = r.requested("item")!; r.submitted(two, state); r.materialChangePending();
  r.completed(two, completion(two), 200, 1500); r.disposition(two, "stale");
  const three = r.requested("augment")!; r.failed(three, "network", 500);
  const b = r.exportBundle()!;
  assert.equal(b.candidateCatalogs.length, 1);
  assert.equal(b.recommendations[0].candidateCatalogRef, b.recommendations[1].candidateCatalogRef);
  assert.deepEqual(b.recommendations[0].snapshot, requestEvidenceSchema.parse(request).snapshot);
  assert.deepEqual(b.recommendations[0].result, run.recommendation);
  assert.equal(b.recommendations[1].disposition, "stale");
  assert.ok(b.events.some((e) => e.type === "material-change-pending" && e.requestId === two));
  assert.equal(b.summary.successfulRequests, 2); assert.equal(b.summary.failedRequests, 1); assert.equal(b.summary.staleResults, 1);
  assert.equal(b.summary.averageRequestLatencyMs, (1200 + 1500 + 500) / 3);
  assert.equal(b.summary.maxRequestLatencyMs, 1500); assert.equal(b.summary.totalTokens, null);
  const other = r.requested("item")!;
  r.completed(other, completion(randomUUID()), 200, 100);
  assert.equal(r.exportBundle()!.recommendations.at(-1)!.snapshot, undefined);
  assert.ok(r.exportBundle()!.events.some((e) => e.data.category === "correlation-mismatch"));
  assert.equal(bundleSchema.safeParse(r.exportBundle()).success, true); r.discard();
});

test("live polls filter time/noise, retain material changes and deduplicate failures", () => {
  const h = harness(), r = h.recorder; r.start(state, data);
  const snapshot = normalizeLiveState(liveFixture(), catalog, 100_000);
  const view = { enabled: true, attached: true, candidate: null, status: "connected" as const, snapshot };
  r.observeLive(view); const n = r.exportBundle()!.events.length, writes = h.writes();
  for (let i = 1; i < 100; i++) r.observeLive({ ...view, snapshot: { ...snapshot, observedAt: snapshot.observedAt + i * 2000, gameTime: i + 120, stats: { ...snapshot.stats, attackDamage: 100.01 } } });
  assert.equal(r.exportBundle()!.events.length, n); assert.ok(h.writes() <= writes + 1);
  r.observeLive({ ...view, snapshot: { ...snapshot, observedAt: 300_000, stats: { ...snapshot.stats, attackDamage: 150 } } });
  assert.equal(r.exportBundle()!.events.filter((e) => e.type === "live-applied").length, 2);
  r.observeLive({ ...view, snapshot: { ...snapshot, inventory: [{ itemId: 123, slot: 0, count: 1, known: true }] } });
  const diagnostic = { category: "unknown-champion", role: "enemy", rawChampionName: "game_character_displayname_UNKNOWN", patch: data.patch, riotId: "PRIVATE#ID" };
  for (let i = 0; i < 20; i++) r.observeLive({ ...view, status: "stale", diagnostic });
  assert.equal(r.exportBundle()!.summary.liveFailures, 1);
  assert.equal(r.exportBundle()!.events.at(-1)!.data.blocked, "existing-attachment-stale");
  assert.doesNotMatch(JSON.stringify(r.exportBundle()), /PRIVATE|sessionKey/); r.discard();
});

test("V1 optional lifecycle evidence preserves legacy bundles and readers, with strict allowlists", () => {
  const h = harness(), r = h.recorder; r.start(state, data);
  const legacy = r.exportBundle()!;
  assert.equal(bundleSchema.parse(legacy).schemaVersion, 1);
  assert.equal(legacy.events[0].data.lifecycle, undefined);
  const accepted = r.requested("item")!;
  r.completed(accepted, completion(accepted), 200, 50);
  r.disposition(accepted, "displayed", { phase: "response", freshness: "outdated", cause: "state-changed", fields: ["items"] });
  const rejected = r.requested("augment")!;
  r.completed(rejected, completion(rejected), 200, 50);
  r.disposition(rejected, "stale", { phase: "response", freshness: "invalid", cause: "offer-changed", fields: ["offeredAugments"] });
  const snapshot = normalizeLiveState(liveFixture(), catalog, 100_000);
  const view = { enabled: true, attached: false, candidate: snapshot, snapshot: null, status: "waiting" as const,
    attachmentReason: "initial-attachment" as const };
  r.observeLive(view);
  r.observeLive({ ...view, attached: true, candidate: null, snapshot, status: "connected" });
  const b = r.exportBundle()!;
  assert.equal(b.schemaVersion, 1); assert.equal(b.droppedEvents, 0);
  assert.equal(b.summary.staleResults, 1);
  assert.equal(b.events.find(e => e.requestId === accepted && e.type === "recommendation-displayed")!.data.lifecycle!.freshness, "outdated");
  assert.deepEqual(b.events.filter(e => e.type === "live-transition").map(e => e.data.attachment?.action), ["confirmation-required", "confirmed"]);
  // The preceding V1 reader projected these optional additions away.
  const legacyEvent = eventSchema.extend({ data: eventSchema.shape.data.omit({ lifecycle: true, attachment: true }) });
  for (const event of b.events) assert.ok(legacyEvent.safeParse(event).success);
  const event = b.events.find(e => e.data.lifecycle)!;
  const sanitized = eventSchema.parse({ ...event, data: { ...event.data,
    lifecycle: { ...event.data.lifecycle, riotId: "PRIVATE#TAG", rawPayload: "PRIVATE" },
    attachment: { action: "confirmed", cause: "participants-changed", riotId: "PRIVATE#TAG" },
  } });
  assert.doesNotMatch(JSON.stringify(sanitized), /PRIVATE|riotId|rawPayload/);
  assert.equal(eventSchema.safeParse({ ...event, data: { lifecycle: { ...event.data.lifecycle, cause: "arbitrary-sensitive-text" } } }).success, false);
  r.discard();
});

test("unknown local and enemy keys preserve exact case and role, with enemy-first failure unchanged", () => {
  for (const index of [0, 6]) {
    const input = liveFixture(); input.players[index].rawChampionName = "game_character_displayname_UNKNOWNcase";
    assert.throws(() => normalizeLiveState(input, catalog), (error: unknown) => {
      assert.ok(error instanceof LiveDataError);
      assert.deepEqual(error.diagnostic, { category: "unknown-champion", role: index ? "enemy" : "local-player", rawChampionName: "game_character_displayname_UNKNOWNcase" });
      assert.doesNotMatch(JSON.stringify(error.diagnostic), /PRIVATE|riotId|players/); return true;
    });
  }
  const input = liveFixture(); input.players[0].rawChampionName = "local-bad"; input.players[6].rawChampionName = "enemy-bad";
  assert.throws(() => normalizeLiveState(input, catalog), (e: unknown) => e instanceof LiveDataError && e.diagnostic.role === "enemy");
});

test("strict nested allowlists exclude unexpected secrets from storage, restore and export", () => {
  const h = harness(), r = h.recorder; r.start({ ...state, authorization: "SECRET_MARKER", stats: { ...state.stats, cookies: "SECRET_MARKER" } } as ManualGameState, data);
  const id = r.requested("item")!, p = completion(id);
  const poisoned = { ...p, headers: { authorization: "SECRET_MARKER" }, diagnostics: { ...p.diagnostics,
    exception: { stack: "SECRET_MARKER" }, evidence: { ...p.diagnostics.evidence,
      snapshot: { ...p.diagnostics.evidence.snapshot, champion: { ...p.diagnostics.evidence.snapshot.champion, account: "SECRET_MARKER" },
        ownedAugments: p.diagnostics.evidence.snapshot.ownedAugments.map((a) => ({ ...a, descriptionSource: { ...a.descriptionSource, headers: "SECRET_MARKER" } })) },
      candidateItems: p.diagnostics.evidence.candidateItems?.map((i) => ({ ...i, stats: { ...i.stats, authorization: "SECRET_MARKER" } })) } },
    recommendation: { ...p.recommendation, rawResponse: "SECRET_MARKER", primary: { ...p.recommendation.primary, reason: "Reason sk-abc123SECRET" } } };
  r.completed(id, poisoned, 200, 1000); r.flush();
  assert.doesNotMatch(JSON.stringify(r.exportBundle()), /SECRET_MARKER|sk-abc123SECRET|rawResponse|authorization|cookies/);
  const stored = JSON.parse(h.entries.get(RECORDING_KEY)!); stored.events[0].data.headers = "SECRET_MARKER";
  h.storage.setItem(RECORDING_KEY, JSON.stringify(stored));
  const fresh = new SessionRecorder(); fresh.recover(h.storage);
  assert.doesNotMatch(JSON.stringify(fresh.exportBundle()), /SECRET_MARKER/); fresh.discard(); r.discard();
});

test("event, request and byte retention stop capture predictably and storage failures stay isolated", () => {
  const h = harness(), r = h.recorder; r.start(state, data);
  for (let i = 0; i < LIMITS.events + 50; i++) r.event("recommendation-overlap-prevented");
  const b = r.exportBundle()!; assert.equal(r.active, false); assert.equal(b.events.length, LIMITS.events);
  assert.equal(b.events.at(-1)!.data.reason, "retention-limit"); assert.equal(b.droppedEvents, 1); r.discard();
  const requests = new SessionRecorder(); requests.start(state, data);
  for (let i = 0; i < 81; i++) requests.requested("item");
  assert.equal(requests.active, false); assert.equal(requests.exportBundle()!.recommendations.length, 80); requests.discard();
  const large = new SessionRecorder(); large.start(state, data);
  for (let i = 0; i < 200; i++) large.event("live-warnings", { warnings: ["a".repeat(40_000)] });
  assert.equal(large.active, false); assert.ok(Buffer.byteLength(JSON.stringify(large.exportBundle())) < LIMITS.bytes); large.discard();
  const broken = new SessionRecorder({ storage: { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("quota"); }, removeItem: () => { throw Error("blocked"); } } });
  assert.doesNotThrow(() => { broken.start(state, data); broken.flush(); broken.exportBundle(); broken.discard(); });
});

test("disabled recorder does no serialization, clock reads, writes or callbacks", () => {
  let calls = 0;
  const r = new SessionRecorder({ clock: () => { calls++; return 0; }, changed: () => calls++, uuid: () => { throw Error("disabled UUID read"); } });
  const poison = new Proxy({} as ManualGameState, { get: () => { throw Error("disabled state inspected"); } });
  for (let i = 0; i < 1000; i++) { r.observeManual(poison, poison); r.observeLive(poison as never); r.requested("item"); r.materialChangePending(); r.event("new-game"); }
  assert.equal(calls, 0); assert.equal(r.exportBundle(), null);
});

test("provider retry diagnostics aggregate tokens once; subset tokens and latencies stay separate", async () => {
  const events: ProviderCompletionEvent[] = [];
  let calls = 0;
  const provider = new OpenAIRecommendationProvider("offline-secret", "offline-model", { log: () => {}, diagnostic: (e) => events.push(e),
    complete: async () => ++calls === 1 ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, output_tokens_details: { reasoning_tokens: 10 } } }
      : { status: "completed", output_parsed: {}, usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150,
        input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 30 } } } });
  await provider.generate(request, buildRecommendationPrompt(request));
  assert.equal(calls, 2); assert.deepEqual(events.map((e) => e.classification), ["token-exhaustion", "success"]);
  const h = harness(), r = h.recorder; r.start(state, data); const id = r.requested("item")!;
  r.completed(id, completion(id, events), 200, 1200); r.completed(id, completion(id, events), 200, 1200);
  const s = r.exportBundle()!.summary;
  assert.equal(s.providerAttempts, 2); assert.equal(s.inputTokens, 200); assert.equal(s.outputTokens, 70);
  assert.equal(s.totalTokens, 270); assert.equal(s.reasoningTokens, 40); assert.equal(s.cachedInputTokens, 80);
  assert.equal(s.totalServerLatencyMs, 900); assert.equal(s.averageRequestLatencyMs, 1200); r.discard();
  const throwing = new OpenAIRecommendationProvider("offline-secret", "offline-model", { log: () => {}, diagnostic: () => { throw Error("recording failure"); },
    complete: async () => ({ status: "completed", output_parsed: { ok: true } }) });
  assert.deepEqual(await throwing.generate(request, buildRecommendationPrompt(request)), { ok: true });
});

test("HTTP response carries authoritative evidence on success and safe correlated failure without persistence", async (t) => {
  t.mock.method(console, "error", () => {});
  const oldProvider = process.env.MAYHEM_RECOMMENDATION_PROVIDER, oldKey = process.env.OPENAI_API_KEY;
  const oldNode = process.env.NODE_ENV;
  try {
    Object.assign(process.env, { NODE_ENV: "test", MAYHEM_RECOMMENDATION_PROVIDER: "fake" });
    const id = randomUUID();
    const send = (body: unknown) => POST(new Request("http://localhost/api/recommend", { method: "POST", body: JSON.stringify(body) }));
    const success = await send({ kind: "item", state, diagnosticRequestId: id });
    const payload = await success.json(); assert.equal(payload.diagnostics.requestId, id);
    assert.deepEqual(payload.diagnostics.evidence.snapshot, requestEvidenceSchema.parse(payload.debug.request).snapshot);
    assert.equal(payload.diagnostics.outcome, "success"); assert.equal(success.headers.get("cache-control"), "no-store");
    const disabled = await (await send({ kind: "item", state })).json(); assert.equal(disabled.diagnostics, undefined);
    delete process.env.MAYHEM_RECOMMENDATION_PROVIDER; delete process.env.OPENAI_API_KEY;
    const failure = await send({ kind: "item", state, diagnosticRequestId: id });
    const failed = await failure.json(); assert.equal(failed.ok, false); assert.equal(failed.diagnostics.requestId, id);
    assert.equal(failed.diagnostics.outcome, "NOT_CONFIGURED"); assert.ok(failed.diagnostics.evidence.snapshot);
    assert.equal(failed.diagnostics.failureClassification, "provider-request");
    assert.doesNotMatch(JSON.stringify(failed.diagnostics), /OPENAI_API_KEY|"stack":|"headers":|offline-secret/);
    const malformed = await (await send({ kind: "item", state: { notState: true }, diagnosticRequestId: id })).json();
    assert.equal(malformed.diagnostics.requestId, id); assert.equal(malformed.diagnostics.outcome, "INVALID_REQUEST");
    assert.equal(malformed.diagnostics.evidence, undefined);
  } finally {
    for (const [key, value] of [["MAYHEM_RECOMMENDATION_PROVIDER", oldProvider], ["OPENAI_API_KEY", oldKey], ["NODE_ENV", oldNode]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});
