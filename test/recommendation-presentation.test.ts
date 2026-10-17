import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecommendationResult } from "../components/RecommendationResult";
import type { RecommendationResponse } from "../lib/recommendation-contract";
import type { Freshness } from "../lib/recommendation/request-lifecycle";

const advice: RecommendationResponse = { schemaVersion: 1, kind: "augment", primary: { id: 11, name: "Synthetic choice", reason: "Retained reasoning" },
  alternatives: [{ id: 12, name: "Synthetic alternative", reason: "Alternative reasoning", preferWhen: "A different build" }], warnings: ["Synthetic caution"], confidence: "medium" };
const render = (freshness: Freshness, recommendation: RecommendationResponse = advice) => renderToStaticMarkup(createElement(RecommendationResult, {
  recommendation, freshness, pickAction: id => createElement("button", { "data-pick": id }, "Record this pick"),
}));

test("current advice has actions; outdated advice preserves reasoning and removes pick actions", () => {
  assert.match(render({ status: "current", fields: [] }), /Record this pick/);
  const outdated = render({ status: "outdated", reason: "state-changed", fields: ["items"] });
  assert.match(outdated, /Outdated/); assert.match(outdated, /Synthetic choice/);
  assert.match(outdated, /Retained reasoning/); assert.match(outdated, /Alternative reasoning/);
  assert.doesNotMatch(outdated, /data-pick|Record this pick/);
});

test("disconnect advice never claims Current; invalid advice has neither a choice nor actions", () => {
  const disconnected = render({ status: "outdated", reason: "live-unverified", fields: ["liveAvailability"] });
  assert.match(disconnected, /unavailable or unverified/); assert.doesNotMatch(disconnected, /Current/);
  const invalid = render({ status: "invalid", reason: "offer-changed", fields: ["offeredAugments"] });
  assert.match(invalid, /invalid for this game or decision/);
  assert.doesNotMatch(invalid, /Synthetic choice|data-pick|Record this pick/);
});

test("purchased item advice remains readable as outdated without a next-item action claim", () => {
  const html = render({ status: "outdated", reason: "state-changed", fields: ["items"] }, { ...advice, kind: "item" });
  assert.match(html, /ITEM ADVICE/); assert.match(html, /Outdated/); assert.match(html, /Retained reasoning/);
  assert.doesNotMatch(html, /NEXT COMPLETED ITEM|data-pick/);
});
