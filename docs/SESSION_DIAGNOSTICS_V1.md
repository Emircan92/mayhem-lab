# Local session diagnostics V1

Start recording before playing, then stop and choose **Export Session Diagnostics**. Export works during an active recording too. The JSON is the only artifact needed for captured state, offer/recommendation sequence and delivered provider diagnostics. Nothing is uploaded automatically. Discard removes the recording and enables starting a new one; export before discarding. A discard event exists only until the recording is purged, deliberately leaving no discard audit trail.

## Inspected boundaries and design

- `GameStateComposer` owns manual input, independent offered slots, custom ability contexts and owned picks. `recordOfferedAugment` transfers the selected slot/context into ownership and clears all offers. Manual state persists under its existing storage key. New Game clears selections and invalidates pending recommendations.
- `useLiveSync` owns a two-second visible-page poll, shared in-flight refresh, explicit candidate attachment and stale fallback. Its observations never overwrite saved manual fields. Reload starts Live Sync disabled. The normalizer resolves enemy champions before the local champion; lookup remains exact and case-sensitive. An unresolved enemy still blocks the entire observation.
- `RecommendationRequestLifecycle` prevents concurrent submissions and invalidates results after material structural/manual edits. Poll timestamps and live stat fluctuations intentionally do not invalidate recommendations. Recording preserves that behavior.
- The recommendation route computes the authoritative normalized snapshot and candidate set, then validates the provider result. Existing debug data already exposes successful request/provider evidence. The provider already classifies errors and emits safe completion durations and token usage.
- A small browser `SessionRecorder` receives direct calls at these existing boundaries. There is no event bus, backend recorder, database or service. The recorder does not call fetch or the provider. A disabled recorder returns before inspecting or serializing state.
- Each recorded explicit recommendation gets a UUID. That UUID is sent as optional `diagnosticRequestId`. The same HTTP response returns a bounded diagnostic envelope containing that UUID, authoritative snapshot/candidates, provider metadata, at most two completion-attempt diagnostics, server elapsed time and outcome. Failure responses use the same envelope. Malformed state can retain a valid correlation UUID without retaining the invalid body.
- Client HTTP completion is captured **before** the stale-result guard. A later event records stale rejection or a committed success display. Browser transport loss is recorded without pretending server details were received. Server collection is request-local memory only, never a lookup store.

## Timeline and evidence

Every event has `seq`, epoch-millisecond `at`, `gameId`, `source`, `type`, allowlisted `data` and, where relevant, `requestId`. Sequence numbers increase across New Game boundaries. `sessionId` identifies the recording. Generated `gameId` changes on New Game; it is an application boundary, not a Riot match ID. Live roster fingerprints are excluded from the export.

Captured types:

- `session-started`, `session-stopped`, `refresh-recovered`, `new-game`; `session-discarded` is purged with the recording.
- `manual-state-changed` with full bounded manual state and changed fields: champion, enemy IDs, inventory, stats, offers, ownership and ability contexts.
- `offer-slot-changed` with 1-based slot and before/after selection; `inferred-offer-replacement` only for a nonempty slot changing augment identity; `ability-context-changed`, `augment-owned`, `augment-removed`. Ownership records the context actually retained by the application.
- `live-transition` with availability/freshness, attached state and pending-boundary flag; `live-applied`, `live-warnings`, `live-failure`.
- `recommendation-requested`, `recommendation-submitted`, `recommendation-completed`, `recommendation-failed`, `recommendation-stale`, `recommendation-displayed`, `material-change-pending`, `recommendation-overlap-prevented`, `capture-failure`.

Sources distinguish `player`, `live-sync`, `application` and `app-inference`. Server provenance is explicit inside recommendation diagnostics. A slot change is observed UI input; its possible relationship to an in-game reroll remains an inference.

The recommendation table links all request events to submitted state, authoritative snapshot, allowed candidates, complete validated primary/alternatives, explanations, build direction, warnings/confidence, HTTP outcome, disposition and elapsed times. Item candidate metadata is included once per distinct ordered candidate list under `candidateCatalogs`; requests reference it by `candidateCatalogRef`. Augment candidate IDs reference the included offered-slot metadata. Catalog descriptions, kits, deterministic facts/warnings and data-quality fields remain included for standalone strategic analysis.

`live-applied.data.state` is a projection of synchronized fields only: its `fields` array identifies champion, enemy IDs, item IDs and stats. Empty offered/owned arrays in this projection do not clear manual augments. Inventory slot/count/known flags and observation/game times are separate. Structural changes are captured immediately. Live stat-only changes are captured at most every 30 seconds when the change reaches 5% (minimum 1 point; attack speed minimum 0.05). Unchanged polls and insignificant drift produce no timeline entries or storage writes. Exact stats at decision time remain in the recommendation snapshot.

Unknown champion diagnostics preserve the exact `rawChampionName` (up to 512 characters), `local-player` or `enemy` role, catalog patch, `unknown-champion` category and whether the failure blocked initial attachment or left an existing attachment stale. Longer identifiers are omitted. No player list, player names or Riot IDs are retained. Other categories are normalization, transport, incompatible map, unexpected local failure and browser network failure. Repeated identical failures are coalesced until recovery or a different failure.

Provider attempts include model, kind, attempt ordinal, budget, status, incomplete reason, safe classification, duration and available input/output/reasoning/cached/total tokens. Existing allowlisted error category, HTTP status, code, type and provider request ID are preserved. Route validation uses `invalid-recommendation`; exceptions and validation issue text are excluded from the recording. A successful provider attempt followed by validation rejection is still a failed application recommendation.

If an authoritative field cannot pass the capture schema, server diagnostics set `captureIncomplete`; the browser records `capture-failure` and increments the dropped count. Capture failure never changes the recommendation result.

## Privacy, bounds and recovery

All serialization passes through nested Zod field allowlists, including restore and final export. Unexpected nested fields are stripped; SDK exception objects are never passed to the recorder. API keys, authorization data, cookies, headers, environment variables, stacks, account identifiers, chat and raw provider output are not collected. Common `sk-...` and Bearer credential patterns in included text are redacted. Ability-context text and validated explanations are intentional evidence, so arbitrary private text pasted into those allowed fields cannot be identified perfectly by a serializer.

One recording is retained under `mayhem-lab:diagnostics:v1`, separately from gameplay state. Limits are **2000 events**, **80 recommendation requests**, and **4 MiB serialized UTF-8 JSON**. Space is reserved for stopping. Reaching a limit stops capture, preserves existing evidence and reports a dropped-event count where an event/evidence could not fit. A stopped recording is never silently replaced. Pretty-printed exports may be larger than the compact storage representation. Retention is bounded by size/count, with no automatic time-based expiry.

Writes are coalesced to at most once per second during capture, with immediate start/stop/export and page-hide flushes. Ordinary refresh restores both active and stopped recordings. Pending requests at reload become `interrupted` with `response-lost-on-refresh`; they are never reissued. Storage errors stop capture in memory; gameplay continues and an in-memory export remains available. If browser deletion fails, the UI reports that persisted data may remain. An abrupt browser/process crash may lose the last coalesced second; unavailable/quota-limited storage cannot guarantee recovery. Multiple tabs share browser storage; use one recording tab at a time.

Summary counts include augment/item requests, success/failure/interruption, stale dispositions, offer replacements, owned selections, Live Sync failures, all Live Sync status transitions and actual attached/detached flag transitions. Request latency includes client preflight/HTTP work; server latency and summed provider-attempt durations are distinct. Total token usage sums each captured attempt exactly once, including retries. Reasoning tokens are a subset of output tokens, and cached tokens a subset of input tokens: neither is added again to total tokens. Unknown usage is `null`, not fabricated zero.

## Limitations and deferred improvements

- No server-side recovery after a lost response, closed tab, stopped recording or refresh. Work may still complete and incur cost after the browser stops capturing.
- A request started before recording cannot be reconstructed; the UI disables Start while a request is pending. Stop does not cancel paid work.
- SDK-internal transport retries remain unchanged and are not separately measured. Attempt numbers describe application completion attempts. Fake-provider requests have no real model attempts/tokens.
- Result display means a committed success UI state; it does not prove the player read it or followed the recommendation. Owned picks reflect explicit player entry, not an in-game selection signal.
- No match-end detection, confirmed reroll signal, actual gameplay/AFK interruption measurement or hidden model reasoning.
- No fuzzy champion correction, new identity aliases, dropped unresolved enemies, data refresh, prompt/model/candidate-policy/retry changes, overlays, extra Riot calls or automatic model requests.
- Defer multi-tab ownership, longer archives, richer timeline viewers and server recovery unless real-game evidence justifies them. Real ARAM Mayhem field validation is still needed; automated fixtures cannot reproduce every Riot client failure.

## Example export structure

Abbreviated for readability; real exports contain full snapshot/candidate metadata and schema-validated summaries. Timestamps are milliseconds since Unix epoch.

```json
{
  "schemaVersion": 1,
  "sessionId": "a96d26fe-b216-4f20-a329-13b12e5970af",
  "gameId": "4346baae-d8ec-46a9-833c-61c44c16d432",
  "data": { "patch": "16.19.1", "generatedAt": "2026-10-11T00:16:44.766Z" },
  "startedAt": 1792000000000,
  "endedAt": 1792001500000,
  "active": false,
  "events": [
    { "seq": 1, "at": 1792000000000, "gameId": "4346baae-d8ec-46a9-833c-61c44c16d432", "source": "player", "type": "session-started", "data": {} },
    { "seq": 2, "at": 1792000010000, "gameId": "4346baae-d8ec-46a9-833c-61c44c16d432", "source": "app-inference", "type": "inferred-offer-replacement", "data": { "slot": 2, "before": { "augmentId": 1018 }, "after": { "augmentId": 2006 } } }
  ],
  "recommendations": [
    {
      "requestId": "68905e89-f94f-4ab6-89bd-f57ea0a205ba",
      "gameId": "4346baae-d8ec-46a9-833c-61c44c16d432",
      "kind": "item",
      "requestedAt": 1792000020000,
      "outcome": "success",
      "disposition": "displayed",
      "candidateCatalogRef": "items-1",
      "httpStatus": 200,
      "elapsedMs": 1420
    }
  ],
  "candidateCatalogs": [{ "ref": "items-1", "items": [] }],
  "summary": { "itemRequests": 1, "successfulRequests": 1, "failedRequests": 0, "averageRequestLatencyMs": 1420 },
  "droppedEvents": 0,
  "limitations": ["Provider details require a delivered HTTP response."]
}
```

## Files and verification

New modules: `lib/diagnostics/schema.ts` (field allowlists/export contract), `lib/diagnostics/recorder.ts` (bounded local state and summary), `test/session-recording.test.ts` (focused lifecycle/privacy/correlation fixtures).

Integration changes: `components/GameStateComposer.tsx`, `components/useLiveSync.ts`, `lib/live-state.ts`, `lib/live-client/normalize.ts`, `app/api/live-state/route.ts`, `lib/recommendation/api-contract.ts`, `lib/recommendation/provider.ts`, `app/api/recommend/route.ts`. Documentation: this file, `README.md`, `docs/README.md`.

Validation commands: `pnpm test`, `pnpm typecheck`, `pnpm build`. The focused suite also runs with `node node_modules/tsx/dist/cli.mjs --test test/session-recording.test.ts`. Browser smoke validation covers start, manual champion edit, refresh recovery, stop and export in the production app on a separate loopback port, without any model call.

Implementation validation: 17 focused recorder/Live Sync route tests passed; the complete suite passed 86 tests (13 JavaScript and 73 TypeScript). Standalone typecheck and production build passed. No paid model calls or actual match were used for this verification.
