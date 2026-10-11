# Mayhem Lab

Mayhem Lab is a local-first ARAM Mayhem game-state composer with grounded augment and completed-item recommendations over the versioned champion, item, and `KIWI` augment snapshot.

## Run the app

Node.js 20.9 or newer is required.

```sh
pnpm install
cp .env.example .env.local
pnpm dev
```

Set `OPENAI_API_KEY` and `OPENAI_MODEL` in `.env.local`, then open `http://localhost:3000`. Current game state is saved in browser `localStorage`; **New Game** clears it after confirmation.

For local UI testing without a paid model call, set `MAYHEM_RECOMMENDATION_PROVIDER=fake`. The fake always chooses the first valid candidate and is explicitly labeled as non-strategic.

Item requests use `MAYHEM_ITEM_MAX_OUTPUT_TOKENS` (default **8192**, integer **1201–32768**). The configured `OPENAI_MODEL` is unchanged. Output budgets cover reasoning as well as visible JSON ([OpenAI documentation](https://developers.openai.com/api/docs/guides/reasoning)). An item request gets at most one completion retry, only for token exhaustion or an incomplete response without a reported cause; the retry doubles the initial budget up to **32768**. Each item attempt has a 120-second transport timeout and SDK transport retries disabled. Refusals, content filters, transport errors, invalid JSON/schema, and failed local candidate validation do not trigger this retry. Augments retain their existing **1200** output tokens and SDK transport options, with no completion retry.

Server completion telemetry records request kind, configured model, attempt, output budget, completion status, sanitized failure classification, elapsed time, and available input/output/reasoning/cached/total token counts. It excludes API credentials, raw exceptions, response text, prompts, and game-state contents. Provider completion success is separate from local recommendation validation; validation rejection is logged as `invalid-recommendation`. Responses remain `store: false`; no telemetry is added to persisted gameplay state.

Expand **Recommendation debug** below the page to inspect the normalized snapshot, the exact candidate-constrained request, provider/model label, and locally validated structured response. Provider credentials are server-only and are never included in this panel.

## Refresh the snapshot

Node.js 20.9 or newer is the only runtime requirement.

```sh
npm run data:refresh
```

If `npm` is unavailable, run the script directly:

```sh
node scripts/refresh-data.mjs
```

The command resolves the newest Riot Data Dragon version, derives and verifies the matching pinned CommunityDragon patch, validates all normalized records, and writes `data/generated/<data-dragon-patch>/`.

An explicit historical Data Dragon patch can be requested with `--patch`:

```sh
node scripts/refresh-data.mjs --patch 16.19.1
```

The application runtime should read the generated JSON only. It should never fetch these upstream sources during a game.

Item eligibility is generated from the matching CommunityDragon Map12 `KIWI` item lists and merged raw `ItemData` definitions. References are resolved from each patch's assets (including hashed references), rather than maintaining item IDs or list hashes by hand. The item snapshot records source URLs, JSON SHA-256 digests, content build, mode/list memberships, store visibility, purchase restrictions, and classification reasons. The full catalog remains available for inventory lookup; recommendations additionally require `ordinary-shop` eligibility and the existing completed-item checks. Data Dragon's `purchasable` flag alone never authorizes a recommendation.

Conditional purchases, required purchase spells (including quest rewards), absent store evidence, and unknown raw fields fail closed. This deliberately excludes some potentially usable items until their conditions or opaque fields are understood. CommunityDragon contains extracted Riot assets but is not an official shop-eligibility API; assets do not prove that a live server has no additional restrictions. The refresh prints diagnostics and records them in `items.json`; broken references/list schemas stop publication. Review schema diagnostics, all mode-membership additions/removals, and classification changes on every refresh. Comparison uses the newest eligible snapshot at or before the requested patch (including the existing snapshot on a same-patch refresh); the first migration explicitly reports that there is no eligibility baseline. New generated patches still require explicitly updating the app's pinned imports.

## Rerun the Volibear calibration

With the development server running and a real recommendation provider configured, run:

```sh
pnpm calibrate:volibear
```

This posts the preserved `Volibear / Courage of the Colossus / Dropkick / Clown College` state from `data/calibration/volibear-dropkick.json` to the local recommendation endpoint. It prints the validated recommendation and request-size measurements; it does not assert which augment must win. Set `MAYHEM_CALIBRATION_URL` to target a different local endpoint.

For offline item payload measurements using the same preserved state, run `pnpm measure:item-payload` (or pass another existing fixture path). This reconstructs the original completed-item filter and provider input, then compares them with the mode-aware filter and current provider parameters. It makes no model/API call, retains full descriptions, and prints only aggregate sizes. The Volibear fixture supplies game state for size measurement; it is not an item-choice quality calibration. No Rumble, Garen, or Karthus calibration states are bundled.

Pinned 16.19.1 results, in UTF-8 bytes (JSON bodies, excluding HTTP headers):

| Measurement | Before | After |
| --- | ---: | ---: |
| Candidates | 192 | 98 |
| Normalized candidate JSON | 92,263 | 48,077 |
| Normalized recommendation request | 104,628 | 60,442 |
| Provider input string | 87,001 | 50,265 |
| Provider JSON body, including instructions and strict response schema | 96,890 | 57,269 |

These measurements use the example model name and default budgets. They are byte counts, not estimated model tokens. Live model quality, latency, and sufficient reasoning budget still require real-game calibration; the offline suite verifies retry bounds, strict validation, and eligibility behavior.
