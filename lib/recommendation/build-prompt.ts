import type { RecommendationRequest } from "../recommendation-contract";

export type RecommendationPrompt = {
  instructions: string;
  input: string;
};

const INSTRUCTIONS = `You are Mayhem Lab's live ARAM Mayhem recommendation reasoner.
Interpret the supplied facts; never invent the game state.

Rules:
- Select primary and alternatives only from the supplied candidates, using their exact IDs and names.
- Supplied snapshot facts and deterministic constraints override generic League knowledge.
- Do not assume unsupplied augments, items, stats, mechanics, or hidden values.
- Explicitly consider reported stats. A stat-cap fact means additional value in that stat has no intrinsic benefit, though an item's other properties may still justify it.
- Evaluate every offered candidate against the player's specific champion abilities, owned augments, current items, reported stats, and specific enemy champion abilities or threats.
- Prefer concrete, state-specific interaction reasoning over generic champion-role or build-archetype reasoning.
- Before choosing, consider whether any supplied player ability, enemy ability, item, augment, or reported stat materially changes a candidate's value.
- Mention only interactions that affect the decision; do not mechanically list every champion or ability.
- Treat ordinary champion builds as context, not authority: the supplied Mayhem augments and state can change the correct direction.
- Acknowledge material warnings and data-quality uncertainty. Do not claim precise hidden mechanics absent from the snapshot.
- Keep reasons concise and immediately useful during a live game.
- Return at most two alternatives. Use warnings for decision-relevant uncertainty only.`;

// Augment-only guidance: preserve the item task and the validated response shape.
// These are evaluation questions, not predictions or champion-specific rankings.
const AUGMENT_EVALUATION = {
  horizons: {
    immediate: "Compare power with current items and reported stats; missing stats are unknown, not zero.",
    midgame: "Compare value if the next plausible purchases support the current or candidate-enabled build direction.",
    lateGame: "Compare plausible late-game scaling conditionally. ARAM Mayhem can allow scaling builds, but remaining game duration and a full build are not guaranteed.",
  },
  buildDirection: "Consider build-defining synergy with owned augments and items, and how each choice changes future itemization. Do not assume future purchases or unoffered augments are owned or guaranteed.",
  practicalValue: "Distinguish general, ultimate-only and basic-only ability haste, resets and temporary post-ultimate windows. Compare ultimate uptime separately from basic-ability throughput. Evaluate which supplied abilities drive meaningful damage or utility, and whether their cast cadence, toggles, channels, resources or access to enemies limit the benefit. More nominal haste or stats need not yield proportional practical output; consider existing haste and diminishing practical returns.",
  opportunityCost: "Compare the opportunity cost of passing a build-enabling scaling augment now with the risk that it comes online too late. Do not dismiss scaling solely because its relevant stat is currently low or zero, or prefer it solely for a hypothetical maximum.",
  grounding: "Separate factual scaling in supplied descriptions from conditional assumptions about future stats and fight opportunities. Do not invent future stat totals, exact cooldowns, breakpoints, haste stacking rules or missing numerical augment effects. If the kit omits ability timing or scaling details, make the practical benefit conditional and acknowledge decision-relevant uncertainty; no full-build simulation is required.",
  response: "In the existing primary reason and buildDirection, summarize the decisive now-versus-later tradeoff and the build assumption that supports it. Use an alternative's preferWhen for the condition that could reverse the choice. Keep this concise; do not output an exhaustive analysis of every horizon.",
};

export function buildRecommendationPrompt(request: RecommendationRequest): RecommendationPrompt {
  const {
    facts: deterministicFacts,
    warnings: deterministicWarnings,
    dataQuality,
    ...normalizedState
  } = request.snapshot;
  const task = request.kind === "augment"
    ? {
        objective: "Choose the best currently offered augment.",
        candidatePolicy: "Only IDs in candidateAugmentIds are legal choices.",
        candidates: request.snapshot.offeredAugments.filter((candidate) => candidate !== null),
        evaluation: AUGMENT_EVALUATION,
      }
    : {
        objective: "Recommend the next completed item.",
        candidatePolicy:
          "Only candidateItems are legal choices. They are completed items established as ordinary KIWI shop purchases by pinned mode membership and raw purchase restrictions; conditional and unresolved items are excluded.",
        candidates: request.candidateItems.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          description: candidate.description,
          stats: candidate.stats,
          tags: candidate.tags,
          totalGold: candidate.gold.total,
        })),
      };

  return {
    instructions: INSTRUCTIONS,
    input: JSON.stringify({
      task,
      facts: {
        normalizedState,
        deterministicFacts,
        deterministicWarnings,
        dataQuality,
      },
      constraints: {
        responseKind: request.kind,
        allowedCandidateIds: request.kind === "augment"
          ? request.candidateAugmentIds
          : request.candidateItems.map((candidate) => candidate.id),
      },
    }),
  };
}

