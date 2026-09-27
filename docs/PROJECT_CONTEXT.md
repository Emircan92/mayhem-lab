# Mayhem Lab — Project Context

_Last updated: 2026-09-27_

## What Mayhem Lab is

Mayhem Lab is a fast, practical companion for **League of Legends ARAM Mayhem**.

The product exists to answer questions that ordinary build/stat sites handle poorly because Mayhem changes normal League build logic through unusual combinations of:

**champion kit × augments × current build/stats × enemy composition × Mayhem mechanics**

Core questions include:

- Which of these offered augments should I take?
- What item should I buy next?
- Given my champion, owned augments, current items/stats, and the enemy team, what build direction makes sense?
- Has Mayhem changed the normal build logic?
- Is a normally good stat now saturated, redundant, or low-value because of Mayhem effects?
- Has my augment stack changed my champion into a different practical archetype?

Example failure we explicitly want to avoid:

> Caitlyn already has 100% crit through Mayhem effects, but a generic build recommender blindly continues buying crit because that is normal Caitlyn logic.

Mayhem Lab should reason about the **current state of this specific game**, not merely repeat a standard champion build.

---

## Product principle

The first useful version should be something that can be used during a real Mayhem game.

The V0 success criterion is:

> I can alt-tab during a Mayhem game, enter the relevant state in roughly 15 seconds, and get a recommendation I would genuinely consider acting on.

Mayhem Lab should move **much faster and more experimentally than Pathwise**.

Avoid:

- grand architecture
- premature infrastructure
- building generic systems before they are justified
- exhaustive Mayhem modeling before real use
- turning this into another League statistics site

The project should grow by **using it while playing**, finding where recommendations fail, and hardening only the failure modes that matter.

---

## Relationship to Pathwise

Mayhem Lab is separate from Pathwise.

Pathwise solves a reconstruction problem: establish what happened from Riot evidence, then interpret it, then eventually recommend alternatives.

Mayhem Lab solves a different problem: the user can explicitly provide the relevant live game state, so the difficult part is not reconstructing history. The difficult part is **strategic reasoning over interacting Mayhem effects**.

We should borrow one major principle from Pathwise:

> AI must not invent the factual game state.

But we should **not** copy Pathwise's deterministic-first architecture wholesale.

For Mayhem Lab:

- structured/deterministic data establishes facts and hard constraints
- AI reasons about what those facts mean strategically

---

## V0 product shape

V0 is a **fast manual game-state composer plus grounded AI recommendation**.

### Inputs

Required/primary:

- champion
- owned augments
- currently offered augments, when asking for an augment choice
- current items
- enemy champions

Optional but important:

- current stats such as crit chance, attack speed, AD, AP, armor, MR, haste, health
- ability slot affected by an augment when the augment is ambiguous
- explicit build-direction override for genuinely hybrid champions if useful

### Primary actions

The first UI should support two explicit actions:

1. **Choose Augment**
2. **Recommend Next Item**

### Output shape

For augment choice:

- primary augment recommendation
- concise explanation tied to current state
- one or two alternatives
- what would make an alternative preferable
- warnings/confidence when an interaction is uncertain

For next item:

- one primary completed item
- concise explanation tied to current state
- one or two situational alternatives
- build-direction note where helpful
- warnings/confidence when an interaction is uncertain

Do not output a giant full-game build plan unless specifically requested.

---

## What V0 is not

V0 is not:

- a win-rate dashboard
- a tier list
- a standard champion build site
- a match-history product
- a full deterministic build engine
- a DPS simulator
- an overlay
- an OCR system
- a public hosted service
- a Riot API-key product

It should not refuse recommendations merely because the champion lacks a hand-authored profile.

All champions should be usable in V0. If the reasoning layer lacks confidence in a particular interaction, it should say so rather than return `unsupported profile`.

---

## How the project should evolve

The preferred development loop is:

1. build the smallest usable version
2. use it in a real Mayhem match
3. capture bad or questionable recommendations
4. classify why the recommendation failed
5. add the smallest fix that addresses the real failure
6. repeat

Failure categories should include:

- missing or wrong source data
- bad/ambiguous augment description
- missing deterministic constraint
- AI reasoning failure
- interaction genuinely not represented well enough
- UI friction / state-entry too slow

Deterministic rules should be **discovered from real failures**, not exhaustively invented before first use.

Known example:

- if crit chance is already capped, additional crit should not be treated as valuable by default

---

## Near-term milestone sequence

The intended order is:

1. normalized static data snapshot
2. fast manual interaction screen
3. grounded AI recommendation contract
4. real-game testing
5. Live Client Data API automation if the product proves useful

The project should resist adding complexity before real usage justifies it.
