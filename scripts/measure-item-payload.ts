import { readFile } from "node:fs/promises";
import augments from "../data/generated/16.19.1/augments.json";
import champions from "../data/generated/16.19.1/champions.json";
import items from "../data/generated/16.19.1/items.json";
import manifest from "../data/generated/16.19.1/manifest.json";
import type { Augment, Champion, Item } from "../lib/catalog";
import type { ManualGameState } from "../lib/game-state";
import { normalizeCatalogItem } from "../lib/preprocess-game-state";
import { createItemRecommendationRequest } from "../lib/recommendation-contract";
import { buildRecommendationPrompt } from "../lib/recommendation/build-prompt";
import { itemCandidateExclusion } from "../lib/recommendation/candidate-policy";
import { OpenAIRecommendationProvider, type CompletionRunner } from "../lib/recommendation/provider";
import { createRecommendationRequest, runRecommendation } from "../lib/recommendation/service";

// Offline measurement only: no server, credentials, or model call. Preserve the fixture's exact state.
const fixturePath = process.argv[2] ?? "data/calibration/volibear-dropkick.json";
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const catalog = { champions: champions.champions as Champion[], augments: augments.augments as Augment[], items: items.items as Item[] };
const metadata = { patch: manifest.riotDataDragonPatch, generatedAt: manifest.generatedAt };
const after = createRecommendationRequest("item", fixture.request.state as ManualGameState, catalog, metadata, catalog.items);
if (after.kind !== "item") throw new Error("Expected an item request.");

// The new eligibility gate runs after every original completed-item check. Include exactly the
// items rejected only by that new gate to reconstruct the pre-fix candidate set for measurement.
const beforeCandidates = catalog.items.filter((item) => {
  const exclusion = itemCandidateExclusion(item);
  return exclusion === null || exclusion === "not-established-KIWI-shop-purchase";
}).map(normalizeCatalogItem).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
const before = createItemRecommendationRequest(after.snapshot, beforeCandidates);
const beforePrompt = buildRecommendationPrompt(before);
const beforeInput = JSON.parse(beforePrompt.input);
beforeInput.task.candidatePolicy = "Only candidateItems are legal choices. They are conservative catalog-terminal ARAM records; ambiguous mode variants are retained when metadata cannot disqualify them.";
beforePrompt.input = JSON.stringify(beforeInput);

let parameters: Parameters<CompletionRunner>[0] | undefined;
const provider = new OpenAIRecommendationProvider("offline-measurement-no-network", process.env.OPENAI_MODEL ?? "gpt-6-astra", {
  log: () => {},
  complete: async (body) => {
    parameters = body;
    const candidate = after.candidateItems[0];
    return { status: "completed", output_parsed: {
      schemaVersion: 1, kind: "item", primary: { id: candidate.id, name: candidate.name, reason: "Offline measurement only." },
      alternatives: [], buildDirection: null, warnings: [], confidence: "low",
    } };
  },
});
const run = await runRecommendation(after, provider);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
console.log(JSON.stringify({
  fixture: fixturePath, patch: metadata.patch, measurement: "UTF-8 JSON bytes; no HTTP headers; offline, not model quality calibration",
  before: { candidates: beforeCandidates.length, candidateJsonBytes: bytes(beforeCandidates), normalizedRequestBytes: bytes(before),
    providerInputBytes: Buffer.byteLength(beforePrompt.input, "utf8"),
    providerBodyBytes: bytes({ ...parameters, input: beforePrompt.input, max_output_tokens: 1200 }) },
  after: { candidates: after.candidateItems.length, candidateJsonBytes: bytes(after.candidateItems), normalizedRequestBytes: bytes(after),
    providerInputBytes: Buffer.byteLength(run.prompt.input, "utf8"), providerBodyBytes: bytes(parameters) },
}, null, 2));
