# Strategic foresight and shopping scope

## Implemented

Augment requests now carry an augment-only evaluation rubric in `task.evaluation`. Response schema, offered candidate IDs, snapshot normalization, item task, provider model, output budgets and retry behavior are unchanged.

The rubric compares immediate power, value after plausible next purchases and conditional late-game scaling. It considers build direction alongside owned augments/items, ultimate uptime separately from basic throughput, and whether cast cadence, toggles, channels, resources or enemy access limit nominal stat benefits. It weighs passing a scaling choice now against getting its benefit too late. Neither zero current scaling stats nor a hypothetical maximum determines the choice.

The existing primary reason/build-direction note should summarize the decisive horizon tradeoff; an alternative's `preferWhen` should identify a condition that could reverse it. Future stats, purchases, game duration and missing timing values stay conditional. Missing reported stats stay unknown rather than becoming zero. No full-build simulation or exhaustive visible analysis is requested.

### Karthus and evidence limits

Pinned Eureka (1030) states that haste equals 30% of AP. At 0 reported AP its immediate conversion is zero, but an AP direction can make later ultimate and useful basic-spell opportunities valuable. Pinned Ultimate Awakening (1349) gives ultimate haste and a temporary post-R basic reset/haste window; its curated description omits amounts, duration and internal cooldown. The request must not manufacture those values or declare a numerical winner.

The Karthus kit supplies Requiem's three-second channel and global damage, Defile's aura/mana drain and Lay Waste's delayed blast. It does **not** supply Q cooldown, AP ratios, R base cooldown or current ability ranks. The prompt therefore asks about Q cast cadence and practical basic-haste benefit conditionally. It cannot prove an exact Q-throughput ceiling or ultimate cooldown reduction in seconds. Capturing verified ability timing would be a separate data improvement, not a hardcoded ranking.

The early fixture illustrates favoring Eureka **if** continued AP purchases are plausible, with Ultimate Awakening preferred for earlier ultimate access before that payoff. The established-AP fixture illustrates penetration winning despite Eureka's large nominal conversion, and Vayne illustrates Ultimate Awakening winning in a physical direction. These are authored examples, not required winners or observed model results.

## Calibration

`data/calibration/strategic-foresight.json` contains four review cases and contract-valid authored examples:

| Case ID | Evidence | Review focus |
| --- | --- | --- |
| `karthus-zero-ap` | 0 AP/haste, empty inventory, Eureka and Ultimate Awakening | Future AP/ultimate uptime, immediate-power alternative, practical basic haste, risk of delayed payoff |
| `karthus-established-ap` | 600 AP, 200 haste, Phenomenal Evil/ADAPt, AP items | Existing synergy, diminishing practical returns, no double-counted AP, penetration alternative |
| `vayne-physical-direction` | 0 AP, six physical/attack items, capped crit | No universal scaling winner; Final Hour/Tumble and damage-pattern interactions |
| `karthus-unknown-stats` | Missing AP/haste, Blasting Wand, unresolved Witchful Thinking amount | Unknown is not zero; preserve description-quality warnings and conditional alternatives |

Scenario labels, review criteria and examples are never sent to the model. No winning ID is encoded in production logic or asserted by deterministic tests.

`pnpm calibrate:foresight` inspects all constructed prompts and locally validated illustrations **offline**, making no HTTP/model calls. To explicitly request one real calibration against the running local app:

```sh
pnpm calibrate:foresight --live karthus-zero-ap
```

`MAYHEM_CALIBRATION_URL` can select another loopback endpoint. The live command sends one request for the named case with a diagnostics UUID and prints the validated recommendation, manual criteria, correlated server evidence, elapsed time and available provider timing/token usage. There is no batch, script retry or AI quality judge. Server provider behavior remains unchanged; fake-provider metadata identifies non-strategic output.

Review each criterion manually, especially whether zero-AP reasoning considers future AP and ultimate uptime. Different winners are acceptable with sound, conditional reasoning. Deterministic tests check construction, missing-data semantics, IDs/names, malformed output rejection, provider settings, V1 recording and stale results. They do not establish semantic model quality. No paid calibration was run for this implementation.

## Shopping inspection and deferral

**Plan Purchases** is deferred under the requested scope fallback. There is no partially validated checkout UI or new gold input. The existing next-item action recommends a completed-item target, not a budget/slot-validated purchase sequence. Budget/component/slot tests require a checkout implementation; the acceptance matrix below defines that follow-up.

| Boundary | Current evidence | Gap for a checkout plan |
| --- | --- | --- |
| Live active player | Transport already fetches `/liveclientdata/activeplayer`; Riot's [documented response](https://developer.riotgames.com/docs/lol#game-client-api_live-client-data-api) includes top-level `currentGold`. | `activeSchema` strips it; live/manual/recommendation state contains no gold. No extra Riot endpoint is needed. |
| Versioned items | `Item` retains Data Dragon base/total prices and `from`/`into`; duplicate recipe entries exist (two Rods for Deathcap). | Normalized recommendation/diagnostic items omit combine cost and recipes. Generic Data Dragon data does not verify effective KIWI checkout costs/recipes. |
| Mode eligibility | KIWI list membership, raw visibility and explicit restrictions fail closed for missing/conditional/unresolved eligibility; 105 completed candidates include seven eligible boots with later upgrades. | Candidate policy does not validate runtime ownership conflicts or checkout feasibility. Components are excluded from the completed-item policy. |
| Raw metadata | Parser recognizes `price`, `recipeItemLinks`, `specialRecipe`, `sidegradeItemLinks`, `mItemGroups`, `maxStack`, mode overrides and script-related fields. | These are not retained as checkout evidence. Group definitions/limits, effective costs/recipes and special upgrade semantics cannot be recovered from `ordinary-shop`. |
| Inventory | Six ordinary slots; live observations retain slot/count/known flags, duplicates and transformed items; trinkets excluded. | Requests carry one ID per occupied slot, without stack/slot metadata. No component consumption, group-limit or sequential slot simulator exists. |
| Diagnostics | UUID-correlated snapshots/candidates/results, provider timing/tokens and stale/display disposition. | Kind/result/evidence/count schemas allow augment/item only. Planner evidence needs a bounded additive extension. |
| Staleness | Existing lifecycle invalidates manual/structural edits, ignoring poll times and live stat drift. | Plans need frozen gold/source and decrease/override checks; passive gold increases should not continually invalidate unrelated recommendations. |

All ordinary-shop recipes in the pinned snapshot satisfy `base + sum(direct component totals) == total`. This arithmetic check does not establish effective mode overrides, item-group limits or special upgrades. Even a completed-items-only planner could recommend conflicting groups or mishandle owned components. Correct planning therefore requires more than a prompt and small contract change.

No data refresh, endpoint, provider setting, diagnostics schema or live-state behavior was changed. Runtime gameplay still reads bundled static data.

## Bounded planner follow-up design

### Checkout evidence

Extend the existing pinned generator, without a new service. Retain resolved recipe occurrences, combine/total prices, resolved item groups/limits, stack limit, restrictions, special recipe/sidegrade flags and effective mode overrides, with source/digest provenance. Reject missing/conflicting references, cycles, invalid prices, inconsistent totals and unsupported semantics. Verify full-inventory assembly behavior before claiming atomic upgrades at six occupied slots.

Use a separate planner candidate builder. Completed targets retain every existing eligibility rule. Components independently require ordinary KIWI shop evidence and supported checkout metadata; do not remove the component exclusion from the next-item action. Ownership lookup can include non-purchasable/transformed items without authorizing their purchase.

First subset: ordinary non-stacking items with verified recipes/prices/groups, at most six purchase entries; no sales, refunds, sidegrades, transformations, script discounts or special upgrades. Unknown inventory IDs or unsupported ownership/stack metadata block planning. Missing evidence fails closed, not merely with a warning.

### Frozen input and explicit action

Normalize finite nonnegative `currentGold` as optional, outside champion stats. Missing/malformed gold makes gold unavailable without discarding a usable observation. Default to fresh, explicitly attached Live Sync gold, with a manual nonnegative override. Floor fractional live gold conservatively for budgeting; retain reported value, budget, source and observation time. No new Riot call or automatic model request is needed.

On **Plan Purchases**, reuse the in-flight lock/stale preflight and freeze gold/source, manual revision and live inventory metadata. Server code constructs all cost/recipe/slot evidence; browser-supplied prices cannot authorize purchases. Sequential live endpoints are not an atomic checkout transaction, which remains a limitation.

### One strategic response and sequential validation

One logical `shopping-plan` request supplies authorized candidates, recipes/cost evidence, budget, owned augments, champion/enemy kits and items. A strict response contains ordered exact IDs/names, short reasons, build direction, warnings/confidence and an optional future target. Use one `generate` call; retain configured model and existing item completion retry behavior, with no per-item requests or automatic model repairs.

The model chooses strategy/order; the server computes spend and slots. For each entry:

1. Check exact ID/name, candidate membership and inventory-dependent restrictions/groups.
2. Match owned component **occurrences** against the resolved recipe tree. Allocate each occurrence once, including duplicate components. Never credit both an owned parent and its descendants, or arbitrary unrelated owned-item totals. Reject unsupported matching semantics.
3. Compute verified total minus consumed component credit. Remove matched occurrences, add the result, enforce groups/limits and capacity at every step. Full-inventory assembly requires verified semantics and consumption that frees capacity; sufficient gold alone cannot authorize an unrelated item at six slots.
4. Deduct from remaining frozen gold and simulate the next entry against the resulting inventory. Components consumed earlier cannot be reused. Reject the entire invalid/over-budget/impossible sequence; do not silently rearrange it or report a partial invalid result as success.

Return server-enriched checkout costs, consumed components, resulting slots, total estimated spend and remaining gold. An affordable next component is another validated purchase entry. An authorized future target is explicitly **not purchased**, with a grounded reason (insufficient gold, no slot or strategic deferral), contributing neither spend nor occupancy. Empty purchases are valid when saving makes sense; do not exhaust gold with low-value filler.

### Stale protection and diagnostics

Keep augment/next-item keys unchanged. Add a plan-specific frozen budget/source revision. Manual gold/source edits, inventory/ownership/champion/enemy changes, New Game and attachment boundaries invalidate plans, including edits later reverted. Recheck current refs immediately before displaying a result. Live gold decreases below submitted budget invalidate it; passive increases can preserve the conservative frozen plan with its original balance/time. Missing/stale live data blocks presenting a live-gold plan as current. No change triggers another AI call.

Preserve V1 exports/allowlists with optional planner input/evidence/result fields and the new kind. Capture reported/budget gold, source/time, deduplicated checkout evidence, validated sequence/consumption, projected spend/remainder and disposition under the existing UUID. Existing timing/token sums count each attempt once. Add a planner request count with legacy missing values treated as zero. Old recordings should restore without synthesized planner evidence; bump version only if compatibility cannot be maintained. Do not capture raw provider output or extra Riot/account data.

### Required deterministic acceptance cases

| Area | Cases required before shipping |
| --- | --- |
| Eligibility | Ordinary completed/component choices; absent/conditional/other-mode/script-gated exclusions; unknown groups/overrides/recipes fail closed; future targets constrained |
| Budget | Zero/exact/one-gold-short, fractional live gold, invalid manual values, empty plan, remaining arithmetic; totals independent of model claims |
| Components | One/two Rods for Deathcap; nested components; ancestor/descendant double-credit prevention; shared components across targets; transformed ownership; component purchased then upgraded |
| Slots/groups | Full inventory consuming upgrade versus unrelated item; every intermediate capacity; duplicate/group conflicts; trinket exclusion; unsupported stacks rejected |
| Staleness | Gold decrease/source edit, inventory change/revert, new game/attachment, stale/missing live data, passive increase, overlapping clicks, response before invalidation effect |
| Structure | Unknown IDs, wrong names/kind, malformed/too many entries, impossible order, invented totals, future target mislabeled as purchase |
| Diagnostics | Old restore/export, new evidence/UUID correlation, tokens/timing counted once, stale/failed outcomes, bounded retention/catalogs, nested-secret exclusion |

Ship the planner only after these checks, typecheck/build and representative live checkout verification pass. Until then, the existing next-item action remains available.
