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
- Treat ordinary champion builds as context, not authority: the supplied Mayhem augments and state can change the correct direction.
- Acknowledge material warnings and data-quality uncertainty. Do not claim precise hidden mechanics absent from the snapshot.
- Keep reasons concise and immediately useful during a live game.
- Return at most two alternatives. Use warnings for decision-relevant uncertainty only.`;

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
      }
    : {
        objective: "Recommend the next completed item.",
        candidatePolicy:
          "Only candidateItems are legal choices. They are conservative catalog-terminal ARAM records; ambiguous mode variants are retained when metadata cannot disqualify them.",
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

