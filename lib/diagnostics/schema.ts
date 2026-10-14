import { z } from "zod";
import { manualGameStateSchema } from "../recommendation/api-contract";

// Every nested object is projected through an explicit field allowlist. Never
// serialize SDK errors, request bodies, headers, or arbitrary debug objects.
const text = z.string().max(40_000).transform((s) => s
  .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
  .replace(/\bBearer\s+[^\s"<>]+/gi, "Bearer [redacted]"));
const num = z.number().finite().nonnegative();
const id = z.number().int();
const texts = z.array(text).max(100);
const selection = z.object({ augmentId: id, abilityContext: text.optional() });
export const stateSchema = manualGameStateSchema.transform((s) => ({ ...s,
  ownedAugments: s.ownedAugments.map((a) => selection.parse(a)),
  offeredAugments: s.offeredAugments.map((a) => a && selection.parse(a)) as typeof s.offeredAugments,
}));
const ability = z.object({ name: text, description: text });
const champion = z.object({ id, key: text, name: text, title: text, tags: texts,
  kit: z.object({ passive: ability, q: ability, w: ability, e: ability, r: ability }) });
const optionalNumber = num.optional();
const itemStats = z.object({ FlatMovementSpeedMod: optionalNumber, FlatHPPoolMod: optionalNumber,
  FlatCritChanceMod: optionalNumber, FlatMagicDamageMod: optionalNumber, FlatMPPoolMod: optionalNumber,
  FlatArmorMod: optionalNumber, FlatSpellBlockMod: optionalNumber, FlatPhysicalDamageMod: optionalNumber,
  PercentAttackSpeedMod: optionalNumber, PercentLifeStealMod: optionalNumber,
  FlatHPRegenMod: optionalNumber, PercentMovementSpeedMod: optionalNumber });
export const itemSchema = z.object({ id, name: text, description: text, plainText: text, stats: itemStats,
  tags: texts, purchasable: z.boolean(), catalogStatus: z.enum(["purchasable", "non-shop-or-transformed"]),
  gold: z.object({ total: num, sell: num }) });
const augment = z.object({ id, internalName: text, name: text, description: text,
  rarity: z.enum(["silver", "gold", "prismatic", "unknown"]), abilityContext: text.optional(),
  requiresAbilityContext: z.boolean(), descriptionStatus: text,
  descriptionQuality: z.enum(["ai-usable", "contextual-usable", "usable-with-missing-detail", "unusable"]),
  unresolvedTokens: texts, descriptionSource: z.object({ type: text.optional(), key: text.optional(), url: text.optional() }) });
const location = { selection: z.enum(["owned", "offered"]), offeredSlot: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() };
const fact = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stat-cap"), stat: z.literal("critChance"), value: num, cap: z.literal(1), unit: z.literal("ratio"), constraint: z.literal("additional-critical-strike-chance-has-no-intrinsic-value") }),
  z.object({ kind: z.literal("augment-context"), augmentId: id, augmentName: text, abilityContext: text, ...location }),
  z.object({ kind: z.literal("item-owned"), itemId: id, itemName: text, count: num }),
  z.object({ kind: z.literal("inventory-summary"), slotCount: num, slotCapacity: z.literal(6), duplicateItemIds: z.array(id) }),
]);
const warning = z.object({ kind: z.enum(["missing-required-selection", "augment-context-missing", "augment-description-missing-detail", "augment-description-unusable"]),
  selection: z.enum(["champion", "owned", "offered"]), offeredSlot: id.optional(), augmentId: id.optional(),
  augmentName: text.optional(), unresolvedTokens: texts.optional(), message: text });
const stat = z.object({ value: num, unit: z.enum(["ratio", "attacks-per-second", "points", "ability-haste"]), reportedPercent: num.optional() });
export const snapshotSchema = z.object({ schemaVersion: z.literal(2), patch: text, generatedAt: text,
  champion: champion.nullable(), ownedAugments: z.array(augment).max(32),
  offeredAugments: z.tuple([augment.nullable(), augment.nullable(), augment.nullable()]),
  items: z.array(itemSchema).max(6), enemies: z.array(champion).max(5),
  enemySummary: z.object({ championCount: num, tagCounts: z.object({ Assassin: optionalNumber, Fighter: optionalNumber,
    Mage: optionalNumber, Marksman: optionalNumber, Support: optionalNumber, Tank: optionalNumber }), basis: z.literal("data-dragon-champion-tags") }),
  stats: z.object({ critChance: stat.optional(), attackSpeed: stat.optional(), attackDamage: stat.optional(),
    abilityPower: stat.optional(), armor: stat.optional(), magicResistance: stat.optional(), abilityHaste: stat.optional(), health: stat.optional() }),
  facts: z.array(fact).max(100), warnings: z.array(warning).max(100),
  dataQuality: z.object({ selectedAugmentCount: num, descriptionQualityCounts: z.object({ "ai-usable": num,
    "contextual-usable": num, "usable-with-missing-detail": num, unusable: num }), missingDetailAugmentIds: z.array(id),
    unusableAugmentIds: z.array(id), unresolvedTokens: z.array(z.object({ augmentId: id, tokens: texts })) }),
});
const choice = z.object({ id, name: text, reason: text, preferWhen: text.optional() });
export const resultSchema = z.object({ schemaVersion: z.literal(1), kind: z.enum(["augment", "item"]),
  primary: z.object({ id, name: text, reason: text }), alternatives: z.array(choice).max(2),
  buildDirection: text.optional(), warnings: texts, confidence: z.enum(["high", "medium", "low"]) });
const classification = z.enum(["success", "token-exhaustion", "incomplete-output", "content-filter", "refusal", "invalid-structured-output", "provider-request", "configuration"]);
const safeCode = z.enum(["insufficient_quota", "organization_spend_limit_exceeded", "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded", "rate_limit_exceeded", "slow_down", "invalid_api_key", "invalid_request",
  "invalid_json_schema", "model_not_found", "context_length_exceeded", "server_error", "server_is_overloaded"]);
export const attemptSchema = z.object({ event: z.literal("mayhem-recommendation-provider"), kind: z.enum(["item", "augment"]), model: text,
  attempt: num.int().max(2), maxOutputTokens: num, status: z.enum(["completed", "incomplete", "failed", "cancelled", "queued", "in_progress", "unknown", "parse-error", "request-error"]),
  incompleteReason: z.enum(["max_output_tokens", "content_filter", "other"]).nullable(), classification,
  inputTokens: num.nullable(), outputTokens: num.nullable(), reasoningTokens: num.nullable(), cachedInputTokens: num.nullable(), totalTokens: num.nullable(), elapsedMs: num,
  errorDiagnostic: z.object({ category: z.enum(["rate-limit", "quota-exhaustion", "authentication", "invalid-request", "connection", "upstream-server", "provider-http", "sdk-error", "unknown-local", "token-exhaustion", "invalid-structured-output"]),
    httpStatus: num.int().min(400).max(599).nullable(), code: safeCode.nullable(),
    type: z.enum(["insufficient_quota", "rate_limit_error", "authentication_error", "invalid_request_error", "server_error", "service_unavailable_error"]).nullable(),
    requestId: z.string().regex(/^req_[A-Za-z0-9]{1,128}$/).nullable() }).optional(),
});
export const requestEvidenceSchema = z.object({ snapshot: snapshotSchema, candidateAugmentIds: z.array(id).max(3).optional(),
  candidateItems: z.array(itemSchema).max(500).optional() });
export const serverDiagnosticsSchema = z.object({ requestId: z.string().uuid(), elapsedMs: num,
  provider: z.object({ provider: z.enum(["openai", "fake"]), model: text }).optional(),
  attempts: z.array(attemptSchema).max(2),
  outcome: z.enum(["success", "INVALID_REQUEST", "NOT_CONFIGURED", "PROVIDER_ERROR", "INVALID_MODEL_RESPONSE"]),
  failureClassification: z.enum(["token-exhaustion", "incomplete-output", "content-filter", "refusal", "invalid-structured-output", "provider-request", "configuration", "invalid-recommendation", "unexpected-error"]).optional(),
  evidence: requestEvidenceSchema.optional(),
  captureIncomplete: z.boolean().optional(),
});
export type ServerDiagnostics = z.infer<typeof serverDiagnosticsSchema>;
export const liveDiagnosticSchema = z.object({ category: z.enum(["unknown-champion", "normalization", "transport", "incompatible-map", "access", "unexpected", "network"]),
  role: z.enum(["local-player", "enemy"]).optional(), rawChampionName: z.string().max(512).optional(), patch: text.optional() });
export type LiveDiagnostic = z.infer<typeof liveDiagnosticSchema>;

export const eventSchema = z.object({ seq: num.int(), at: num, gameId: z.string().uuid(),
  source: z.enum(["player", "live-sync", "app-inference", "application", "server"]),
  type: z.enum(["session-started", "session-stopped", "session-discarded", "refresh-recovered", "new-game",
    "manual-state-changed", "offer-slot-changed", "inferred-offer-replacement", "ability-context-changed", "augment-owned", "augment-removed",
    "live-transition", "live-applied", "live-warnings", "live-failure", "material-change-pending",
    "recommendation-requested", "recommendation-submitted", "recommendation-completed", "recommendation-failed",
    "recommendation-stale", "recommendation-displayed", "recommendation-overlap-prevented", "capture-failure"]),
  requestId: z.string().uuid().optional(), data: z.object({ state: stateSchema.optional(), fields: texts.optional(),
    slot: id.min(1).max(3).optional(), before: selection.nullable().optional(), after: selection.nullable().optional(),
    augment: selection.optional(), kind: z.enum(["item", "augment"]).optional(), elapsedMs: num.optional(), httpStatus: num.int().max(599).optional(),
    category: z.enum(["network", "live-preflight", "response-lost-on-refresh", "INVALID_REQUEST", "NOT_CONFIGURED", "PROVIDER_ERROR", "INVALID_MODEL_RESPONSE", "capture-invalid", "correlation-mismatch"]).optional(),
    reason: z.enum(["user", "retention-limit", "storage-failure"]).optional(), status: z.enum(["disabled", "waiting", "connected", "stale", "unavailable"]).optional(),
    attached: z.boolean().optional(), pendingAttachment: z.boolean().optional(), blocked: z.enum(["initial-attachment", "existing-attachment-stale"]).optional(),
    diagnostic: liveDiagnosticSchema.optional(), warnings: texts.optional(),
    observedAt: num.optional(), gameTime: num.optional(), mapNumber: id.optional(), gameMode: text.optional(),
    inventory: z.array(z.object({ slot: id, itemId: id, count: num, known: z.boolean() })).max(6).optional(),
  }) });
export const recommendationEvidenceSchema = z.object({ requestId: z.string().uuid(), gameId: z.string().uuid(), kind: z.enum(["item", "augment"]),
  requestedAt: num, completedAt: num.optional(), elapsedMs: num.optional(), submittedState: stateSchema.optional(),
  snapshot: snapshotSchema.optional(), candidateAugmentIds: z.array(id).max(3).optional(), candidateCatalogRef: text.optional(),
  result: resultSchema.optional(), httpStatus: num.int().max(599).optional(),
  outcome: z.enum(["pending", "success", "failed", "interrupted"]), disposition: z.enum(["pending", "displayed", "stale", "not-displayed"]),
  category: text.optional(), diagnostics: serverDiagnosticsSchema.omit({ evidence: true }).optional(),
});
export const recordingSchema = z.object({ schemaVersion: z.literal(1), sessionId: z.string().uuid(), gameId: z.string().uuid(),
  data: z.object({ patch: text, generatedAt: text }), startedAt: num, endedAt: num.optional(), active: z.boolean(), nextSeq: num.int(),
  events: z.array(eventSchema).max(2002), recommendations: z.array(recommendationEvidenceSchema).max(80),
  candidateCatalogs: z.array(z.object({ ref: text, items: z.array(itemSchema).max(500) })).max(80),
  droppedEvents: num.int(), limitations: texts,
});
export type Recording = z.infer<typeof recordingSchema>;
export type RecordingEvent = z.infer<typeof eventSchema>;
export const bundleSchema = recordingSchema.extend({ exportedAt: num, summary: z.object({
  augmentRequests: num.int(), itemRequests: num.int(), successfulRequests: num.int(), failedRequests: num.int(), interruptedRequests: num.int(), staleResults: num.int(),
  averageRequestLatencyMs: num.nullable(), maxRequestLatencyMs: num.nullable(), totalServerLatencyMs: num, totalProviderAttemptMs: num,
  providerAttempts: num.int(), inputTokens: num.nullable(), outputTokens: num.nullable(), reasoningTokens: num.nullable(), cachedInputTokens: num.nullable(), totalTokens: num.nullable(),
  offerReplacements: num.int(), ownedSelections: num.int(), liveFailures: num.int(), attachmentTransitions: num.int(), liveTransitions: num.int(),
}) });
