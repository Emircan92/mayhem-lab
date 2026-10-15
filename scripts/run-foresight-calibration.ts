import { randomUUID } from "node:crypto";

import fixture from "../data/calibration/strategic-foresight.json";
import augments from "../data/generated/16.19.1/augments.json";
import champions from "../data/generated/16.19.1/champions.json";
import items from "../data/generated/16.19.1/items.json";
import manifest from "../data/generated/16.19.1/manifest.json";
import type { Augment, Champion, Item } from "../lib/catalog";
import { recommendationApiInputSchema } from "../lib/recommendation/api-contract";
import { buildRecommendationPrompt } from "../lib/recommendation/build-prompt";
import { createRecommendationRequest } from "../lib/recommendation/service";
import { validateRecommendationResponse } from "../lib/recommendation/validate-response";

const catalog = { champions: champions.champions as Champion[], augments: augments.augments as Augment[], items: items.items as Item[] };
const metadata = { patch: manifest.riotDataDragonPatch, generatedAt: manifest.generatedAt };
const args = process.argv.slice(2);
const live = args[0] === "--live";
if (args.length && !(live && args.length === 2)) {
  throw new Error("Usage: pnpm calibrate:foresight [--live <case-id>]. No arguments inspects all cases offline.");
}
const cases = live ? fixture.cases.filter((entry) => entry.id === args[1]) : fixture.cases;
if (!cases.length) throw new Error(`Unknown case. Choose: ${fixture.cases.map((entry) => entry.id).join(", ")}`);
if (fixture.patch !== metadata.patch) throw new Error("Review fixtures against the pinned catalog before calibration.");

for (const entry of cases) {
  const input = recommendationApiInputSchema.parse(entry.request);
  const request = createRecommendationRequest(input.kind, input.state, catalog, metadata, catalog.items);
  const example = validateRecommendationResponse(entry.illustrativeResponse, request);
  if (!example.ok) throw new Error(`${entry.id}: illustrative response failed validation: ${example.issues.join("; ")}`);

  if (!live) {
    console.log(JSON.stringify({
      caseId: entry.id,
      mode: "offline-inspection-no-model-call",
      reviewCriteria: entry.reviewCriteria,
      prompt: buildRecommendationPrompt(request),
      illustrativeResponse: example.value,
      note: "Authored illustration only. Deterministic validation does not establish model reasoning quality.",
    }, null, 2));
    continue;
  }

  const endpoint = new URL(process.env.MAYHEM_CALIBRATION_URL?.trim() || "http://localhost:3000/api/recommend");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    || !["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("Calibration requires a loopback recommendation endpoint.");
  }
  const diagnosticRequestId = randomUUID();
  const started = performance.now();
  // One explicit request for one case; no batch, retry or automatic quality judge.
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, diagnosticRequestId }),
    redirect: "error",
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    console.error(JSON.stringify({ caseId: entry.id, httpStatus: response.status, error: payload.error, diagnostics: payload.diagnostics }, null, 2));
    process.exitCode = 1;
    break;
  }
  const validated = validateRecommendationResponse(payload.recommendation, request);
  if (!validated.ok) throw new Error(`Calibration response failed local validation: ${validated.issues.join("; ")}`);
  if (payload.diagnostics?.requestId !== diagnosticRequestId) throw new Error("Calibration diagnostics correlation mismatch.");
  console.log(JSON.stringify({
    caseId: entry.id,
    mode: "explicit-live-calibration",
    provider: payload.debug?.provider,
    recommendation: validated.value,
    elapsedMs: Math.round(performance.now() - started),
    diagnostics: payload.diagnostics,
    reviewCriteria: entry.reviewCriteria,
    note: "Review these criteria manually; there is no required winner or automatic semantic pass score.",
  }, null, 2));
}
