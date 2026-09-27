# Mayhem Lab — First Implementation Brief for Codex

_Last updated: 2026-09-27_

## Goal

Build the smallest version of Mayhem Lab that can be used during a real ARAM Mayhem game.

Do not expand scope beyond what is needed to test whether the recommendations are genuinely useful.

Read:

- `docs/PROJECT_CONTEXT.md`
- `docs/V0_DECISIONS.md`

before implementation.

---

## Milestone definition

The milestone is successful when the user can:

1. open Mayhem Lab locally
2. select a champion
3. add owned augments
4. optionally enter the three currently offered augments
5. add current items
6. optionally enter current stats
7. add enemy champions
8. click either:
   - `Choose Augment`
   - `Recommend Next Item`
9. receive a grounded structured recommendation quickly enough to use during a live Mayhem game

Do not require Live Client Data API integration for this milestone.

---

## Implementation sequence

### Cut 1 — Static Mayhem data snapshot

Implement one explicit refresh command.

Fetch and normalize:

- Riot Data Dragon champions
- Riot Data Dragon items
- CommunityDragon standard Mayhem / `KIWI` augment membership
- CommunityDragon augment identity metadata
- Mayhem-specific augment descriptions where reliably usable
- item fallback data only when needed

Output versioned local JSON plus a manifest.

Suggested target:

```text
data/
  generated/
    <patch>/
      champions.json
      items.json
      augments.json
      manifest.json
  curated/
      augment-overrides.json
      interaction-rules.json
```

Requirements:

- do not make runtime depend on remote `latest`
- pin generated data to a patch/source
- validate augment membership joins
- ensure names/IDs are unique
- surface unresolved/poor descriptions rather than silently pretending they are clean
- keep the refresh command small and understandable

Do not build generalized ingestion infrastructure.

---

### Cut 2 — Fast manual game-state UI

Build a single useful page.

Controls:

- champion searchable selector
- owned augment searchable multi-selector
- offered augment selectors for three choices
- current item searchable multi-selector
- enemy champion multi-selector
- optional stat inputs:
  - crit chance
  - attack speed
  - AD
  - AP
  - armor
  - MR
  - ability haste
  - health
- optional affected ability slot if needed for an ambiguous augment

Actions:

- `Choose Augment`
- `Recommend Next Item`

Persist current state in `localStorage`.

Provide a clear reset/new-game action.

Prioritize fast keyboard/mouse use over visual polish.

Do not add a state-management framework unless the page genuinely needs one.

---

### Cut 3 — Deterministic preprocessing

Before AI reasoning, compute a small factual summary.

Initial useful facts may include:

- current crit chance
- whether crit appears capped
- owned item IDs
- duplicate/unique warnings where reliable
- obvious item incompatibilities
- patch/data freshness
- current augment identities/descriptions
- enemy roster summary

Do not create a broad recommendation-scoring engine.

Do not create per-champion strategy profiles.

Keep deterministic facts inspectable/debuggable.

Known first regression:

> If current crit chance is already 100%, the reasoning layer must not treat additional crit chance itself as valuable.

An item containing crit can still be valid because of other independent properties.

---

### Cut 4 — AI recommendation layer

Use a typed normalized request.

The model receives:

- current champion
- owned augments and their Mayhem-specific descriptions
- offered augments when applicable
- items
- optional stats
- enemies
- deterministic facts/warnings
- data patch

The model should reason strategically over the supplied facts.

#### Augment action

The model must select only from the supplied offered augments.

Return:

- primary offered augment
- concise reason
- up to two alternatives
- when an alternative is preferable
- warnings
- confidence

#### Item action

The model should recommend one next completed item from the supplied/known legal item catalog.

Return:

- primary item
- concise reason
- up to two alternatives
- build-direction note where useful
- warnings
- confidence

The model must:

- not invent item or augment IDs
- not assume unsupplied augments
- not pretend uncertain interaction knowledge is certain
- explicitly use current Mayhem stats when those invalidate normal build logic
- prefer concise, game-time-readable output

---

### Cut 5 — Real-game calibration

Stop feature development and use the application during real ARAM Mayhem games.

For questionable recommendations, record:

- input state
- recommendation
- why it seemed wrong
- whether the problem was:
  - source data
  - description quality
  - missing deterministic constraint
  - AI reasoning
  - genuinely uncertain interaction
  - UI friction

Only then add the smallest rule/data/UI change required.

Do not preemptively build an exhaustive rules system.

---

## Explicitly out of scope for this milestone

Do not implement:

- Live Client Data API
- LCU
- Riot public API key integration
- match history
- win-rate/statistics dashboards
- tier lists
- database
- authentication
- deployment
- OCR
- screen capture
- overlay
- hotkeys
- exact DPS simulation
- champion-specific recommendation profiles
- five-champion support restriction
- generic deterministic recommendation ranking engine
- automatic scheduled data refresh
- large test corpus before the app has been used

---

## V0.1 candidate after usefulness is proven

If manual V0 is useful, then investigate Riot Live Client Data API integration.

Target automatic imports:

- champion
- current inventory
- current gold
- active-player stats
- teammate/enemy champions
- visible player items

Keep augments manual unless reliable live data proves otherwise.

Use a local server-side proxy to contact the League local endpoint rather than browser-direct access.

Before implementation, capture real Mayhem `/allgamedata` samples and verify actual values and transformed item IDs.

---

## Engineering style

Favor:

- readable code
- small modules
- explicit types
- inspectable normalized data
- a single recommendation path
- minimal dependencies
- local-first execution
- easy deletion/refactoring when experiments fail

Avoid:

- abstract frameworks created for hypothetical future needs
- generic engines with no current caller
- unnecessary persistence layers
- architecture designed around deployment before local usefulness exists

This project is intentionally experimental.

The fastest path to truth is using it while playing.
