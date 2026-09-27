# Mayhem Lab — V0 Product and Architecture Decisions

_Last updated: 2026-09-27_

This file records the decisions made after reviewing the initial Codex reconnaissance.

These are current implementation decisions, not immutable long-term architecture.

---

## 1. V0 definition

V0 is:

> A local Next.js application that lets the user quickly describe the current ARAM Mayhem state and receive a grounded AI recommendation for either the next augment choice or next item purchase.

V0 should be usable during an actual game.

The key question V0 must validate is not:

> Can we automate live League state?

It is:

> Are the recommendations useful enough that the user wants to keep using Mayhem Lab?

---

## 2. Manual-first before Live Client integration

The Riot Live Client Data API is a promising later enhancement and should remain in the design horizon.

However, it is **not required for first useful V0**.

Reasons:

- manual state entry is sufficient to validate recommendation quality
- augment ownership/offers remain manual anyway
- Live Client integration adds local HTTPS/TLS handling, polling, normalization, transient-stat questions, transformed item-ID handling, and player matching
- those concerns do not validate the core product hypothesis

Therefore:

### V0
Manual state input.

### V0.1, after real usefulness is established
Automatically import:

- own champion
- current items
- gold
- current stats
- teams
- enemy champions/items where exposed

Keep augments manual unless a reliable source is discovered.

---

## 3. AI belongs in V0

The initial reconnaissance proposed a thin deterministic recommendation engine and no AI.

We are explicitly **not** taking that approach.

The distinctive Mayhem problem is reasoning about unusual combinations of:

- champion kit
- augments
- current stats
- current items
- enemy composition
- mode-specific mechanics

A broad hand-authored rules engine would require large amounts of champion- and interaction-specific work before the product is useful across the variety of champions the user actually plays.

AI therefore belongs in V0.

The correct constraint is:

> AI may interpret structured facts, but it must not invent those facts.

---

## 4. Deterministic layer versus AI layer

### Deterministic / structured responsibilities

The application should establish or calculate:

- champion identity
- item identity
- augment identity
- Mayhem-specific augment descriptions
- current inventory
- current reported stats
- enemy champion identities
- patch/data version
- item ownership
- obvious duplicate/unique restrictions where reliable
- obvious stat caps or threshold warnings
- hard incompatibilities/exclusions where reliable
- normalized factual summaries supplied to the model

Examples:

- `critChance = 1.00`
- `critCapped = true`
- item X is already owned
- augment Y affects Q
- enemy roster contains champions A/B/C/D/E

### AI responsibilities

AI should reason about:

- which offered augment best fits the current state
- whether an augment meaningfully changes build direction
- whether the champion has effectively pivoted into another archetype
- which stat is currently valuable or saturated
- how enemy composition changes the next purchase
- tradeoffs between two viable build directions
- unusual multi-augment interactions
- situational alternatives
- concise explanation of the recommendation

AI should be allowed to say that an interaction is uncertain.

---

## 5. Hard rules constrain reasoning; they do not replace reasoning

Example deterministic fact/rule:

```text
FACT:
critChance = 1.00
critCapped = true

CONSTRAINT:
Do not value additional critical-strike chance as a reason to recommend an item.
An item containing crit may still be recommended if its other properties independently justify it.
```

This is preferable to building a champion-specific profile such as `CaitlynProfile.ts`.

Use real recommendation failures to identify additional hard constraints.

---

## 6. Champion support

V0 should allow **all champions**.

Do not restrict recommendation support to a curated five-champion roster.

The user plays a wide variety of Mayhem champions, so returning `unsupported profile` for most games would undermine the product immediately.

If data or interaction knowledge is weak:

- lower confidence
- state the uncertainty
- identify the uncertain interaction

Do not fabricate certainty.

---

## 7. Augment recommendations are part of V0

Augment choice is a core first-class use case, not a later feature.

The UI should support:

### Choose Augment

Input includes:

- champion
- owned augments
- three currently offered augments
- current items
- optional current stats
- enemy champions

Output includes:

- recommended offered augment
- short reasoning
- alternatives
- conditions under which an alternative becomes preferable
- uncertainty warning where appropriate

### Recommend Next Item

Input includes:

- champion
- owned augments
- current items
- optional current stats
- enemy champions

Output includes:

- recommended completed item
- short reasoning
- one or two alternatives
- build-direction note where helpful
- uncertainty warning where appropriate

---

## 8. Data-source decisions

### Riot Data Dragon

Use for:

- champion identity/catalog
- standard item identity and baseline metadata
- icons/assets where appropriate

Do not rely on Data Dragon for recommended champion builds.

### CommunityDragon

Use for:

- Mayhem/KIWI augment membership
- augment identity metadata
- augment rarity/icons
- Mayhem-specific string data where usable
- item fallback when necessary

Important runtime principle:

> Do not depend on CommunityDragon `latest` during a game.

Fetch/normalize data at update time and run from a bundled snapshot.

### Augment descriptions

Preferred hierarchy:

1. Mayhem-specific CommunityDragon string data when clean and usable
2. local curated normalization/override when placeholders or internal text make it unsuitable
3. trusted community-readable source as fallback when needed

Do not build a general raw-game-data token resolver before V0 usage demonstrates the need.

### Riot patch notes

Use as an authoritative source for mode-specific changes and fixes, especially when validating changed interactions between snapshots.

### Riot public APIs

Not needed for V0.

Do not add a Riot API key.

### Riot Live Client Data API

Useful later for local live-state automation.

Not part of first useful V0.

### LCU

Postpone.

### OCR / screen capture

Postpone.

---

## 9. Static data snapshot

Create a simple refresh command that generates local normalized data.

Suggested shape:

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
      interaction-rules.json   # only when real failures justify rules
```

The generated manifest should record:

- Riot/Data Dragon patch
- CommunityDragon patch/source
- generation timestamp
- source URLs
- record counts
- validation results

The application should display its data patch/freshness somewhere unobtrusive.

Avoid building automated scheduled ingestion for now.

---

## 10. UI priorities

This is a game-time tool.

Optimize for **speed of state entry**, not design-system completeness.

Important characteristics:

- searchable selectors
- keyboard-friendly interaction where easy
- rapid add/remove of augments/items/champions
- obvious separation between owned augments and offered augments
- compact optional stat fields
- `localStorage` persistence so current state survives refresh
- easy reset for the next game

No additional state-management framework is necessary unless actual complexity demands it.

---

## 11. Recommendation contract

Do not send a loose natural-language blob if avoidable.

Construct a typed normalized snapshot and request structured output.

Conceptual request:

```ts
type MayhemSnapshot = {
  patch: string;
  champion: Champion;
  ownedAugments: Augment[];
  offeredAugments?: Augment[];
  items: Item[];
  stats?: PlayerStats;
  enemies: Champion[];
  deterministicFacts: DeterministicFact[];
};
```

Conceptual response:

```ts
type Recommendation = {
  kind: "augment" | "item";
  primary: {
    id: string;
    name: string;
    reason: string;
  };
  alternatives: Array<{
    id: string;
    name: string;
    reason: string;
    preferWhen?: string;
  }>;
  buildDirection?: string;
  warnings: string[];
  confidence: "high" | "medium" | "low";
};
```

The model must choose only from valid supplied candidates where the action has a fixed candidate set, especially offered augments.

For item recommendations, the model should operate from supplied legal/current item data rather than inventing item IDs.

---

## 12. Explicit non-goals for first useful V0

Postpone:

- match history
- win-rate dashboards
- tier lists
- accounts
- cloud sync
- database
- deployment
- OCR
- screen capture
- overlay windows
- global hotkeys
- LCU integration
- Riot public API integration
- deterministic full build engine
- champion-specific profile library
- exact DPS simulation
- automatic patch updater
- exhaustive interaction-rule taxonomy
- large regression corpus before first use

Testing should exist for important contracts and known hard constraints, but real Mayhem usage is the primary early calibration mechanism.

---

## 13. When to add a deterministic rule

A deterministic rule should normally be added because:

1. a real recommendation was wrong or dangerous,
2. the failure is caused by a factual constraint that can be expressed reliably,
3. encoding that fact prevents a class of repeated reasoning errors.

Examples:

- stat already capped
- duplicate unique effect
- item cannot be purchased in this state/mode
- augment explicitly disables or replaces a mechanic
- transformed/upgraded item makes a normal recommendation redundant

Do not encode subjective strategic preferences as hard rules unless repeatedly justified.
