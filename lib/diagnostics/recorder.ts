import type { ManualGameState } from "../game-state";
import type { LiveSnapshot } from "../live-state";
import { bundleSchema, eventSchema, liveDiagnosticSchema, recordingSchema, resultSchema, serverDiagnosticsSchema,
  stateSchema, type Recording, type RecordingEvent } from "./schema";

export const RECORDING_KEY = "mayhem-lab:diagnostics:v1";
export const LIMITS = { events: 2000, recommendations: 80, bytes: 4 * 1024 * 1024 } as const;
const limitations = [
  "Opt-in local evidence only. New Game, recording, attachment and Riot match boundaries are independent.",
  "Offer replacements are inferred; no confirmed in-game reroll signal exists.",
  "Provider details require a delivered HTTP response. Lost responses and reloads cannot recover server work.",
  "SDK-internal retries are not separate attempts. Fake-provider requests have no model token usage.",
  "Live stat-only changes are sampled at most every 30 seconds with a 5% (minimum 1 point, 0.05 attack speed) threshold; recommendation snapshots preserve exact submitted stats.",
  "Latency measures request/provider time, never AFK time or gameplay interruption. Reasoning and cached tokens are subsets, not additional total tokens.",
  "Free-text ability context and validated explanations are included; obvious credential patterns are redacted. Arbitrary nested fields and raw provider traffic are excluded.",
  "One recording retained, at most 2000 events, 80 requests and 4 MiB serialized UTF-8. Capture stops at a limit; existing evidence is preserved.",
];
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
type Options = { clock?: () => number; uuid?: () => string; changed?: () => void; storage?: Storage };
type EventData = RecordingEvent["data"];
type LiveView = { enabled: boolean; attached: boolean; status: "connected" | "stale" | "waiting" | "unavailable";
  candidate: LiveSnapshot | null; snapshot: LiveSnapshot | null; diagnostic?: unknown };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class SessionRecorder {
  private recording: Recording | null = null;
  private storage?: Storage;
  private readonly clock: () => number;
  private readonly uuid: () => string;
  private readonly changed: () => void;
  private size = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private transition = "";
  private failure = "";
  private lastLive: LiveSnapshot | null = null;
  private warningKey = "";
  constructor(options: Options = {}) {
    this.clock = options.clock ?? Date.now;
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.changed = options.changed ?? (() => {});
    this.storage = options.storage;
  }
  get active() { return this.recording?.active === true; }
  get hasRecording() { return this.recording !== null; }
  get status() {
    const r = this.recording;
    return r ? `${r.active ? "Recording" : "Stopped"} · ${r.events.length} events · ${r.recommendations.length} requests · ${r.droppedEvents} dropped` : "Recording off";
  }
  private notify() { try { this.changed(); } catch { /* never affect gameplay */ } }
  private changedData() {
    this.notify();
    if (this.storage && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 1000);
  }
  private append(type: RecordingEvent["type"], source: RecordingEvent["source"], data: EventData = {}, requestId?: string, force = false) {
    const r = this.recording;
    if (!r || (!r.active && !force)) return;
    try {
      const event = eventSchema.parse({ type, source, data, requestId, gameId: r.gameId, seq: r.nextSeq,
        at: Math.max(this.clock(), r.events.at(-1)?.at ?? r.startedAt) });
      const added = bytes(event) + 1;
      if (!force && (r.events.length >= LIMITS.events - 1 || this.size + added > LIMITS.bytes - 4096)) {
        r.droppedEvents++; this.stop("retention-limit"); return;
      }
      r.events.push(event); r.nextSeq++; this.size += added; this.changedData();
    } catch { r.droppedEvents++; this.changedData(); }
  }
  event(type: RecordingEvent["type"], data: EventData = {}, requestId?: string) {
    if (this.active) this.append(type, "application", data, requestId);
  }
  start(state: ManualGameState, data: Recording["data"], live?: LiveView) {
    // Keep a stopped recording until explicitly discarded/exported by the user.
    if (this.recording) return;
    try {
      this.recording = recordingSchema.parse({ schemaVersion: 1, sessionId: this.uuid(), gameId: this.uuid(), data,
        startedAt: this.clock(), active: true, nextSeq: 1, events: [], recommendations: [], candidateCatalogs: [], droppedEvents: 0, limitations });
      this.size = bytes(this.recording);
      this.append("session-started", "player", { state: stateSchema.parse(state) });
      if (live) this.observeLive(live);
      this.flush();
    } catch { this.recording = null; this.notify(); }
  }
  stop(reason: "user" | "retention-limit" | "storage-failure" = "user") {
    const r = this.recording;
    if (!r?.active) return;
    this.append("session-stopped", "application", { reason }, undefined, true);
    r.active = false; r.endedAt = Math.max(this.clock(), r.events.at(-1)!.at);
    for (const req of r.recommendations) if (req.outcome === "pending") {
      req.outcome = "interrupted"; req.disposition = "not-displayed"; req.category = "recording-stopped-before-result";
    }
    this.notify(); this.flush();
  }
  discard() {
    if (!this.recording) return true;
    this.append("session-discarded", "player", {}, undefined, true);
    this.recording = null; this.size = 0;
    this.transition = ""; this.failure = ""; this.lastLive = null; this.warningKey = "";
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    let removed = true;
    try { this.storage?.removeItem(RECORDING_KEY); } catch { removed = false; }
    this.notify();
    return removed;
  }
  recover(storage: Storage) {
    this.storage = storage;
    if (this.recording) return;
    try {
      const raw = storage.getItem(RECORDING_KEY);
      if (!raw) return;
      if (raw.length > LIMITS.bytes || new TextEncoder().encode(raw).length > LIMITS.bytes) { storage.removeItem(RECORDING_KEY); return; }
      const r = recordingSchema.parse(JSON.parse(raw));
      // Validate chronology and references rather than trusting persisted objects.
      if (r.nextSeq !== r.events.length + 1 || r.events.some((e, i) => e.seq !== i + 1 || (i > 0 && e.at < r.events[i - 1].at))
        || r.recommendations.some((q) => q.candidateCatalogRef && !r.candidateCatalogs.some((c) => c.ref === q.candidateCatalogRef))) return;
      this.recording = r; this.size = bytes(r);
      if (r.active) {
        this.append("refresh-recovered", "application");
        for (const req of r.recommendations) if (req.outcome === "pending") {
          req.outcome = "interrupted"; req.disposition = "not-displayed"; req.category = "response-lost-on-refresh";
          this.event("recommendation-failed", { category: "response-lost-on-refresh" }, req.requestId);
        }
      }
      this.changedData();
    } catch { /* corrupted/disabled storage never blocks the app */ }
  }
  flush() {
    if (!this.recording || !this.storage) return;
    try {
      const raw = JSON.stringify(this.recording);
      if (new TextEncoder().encode(raw).length > LIMITS.bytes) {
        // Never recurse into flush or write an oversized record.
        if (this.recording.active) {
          this.recording.active = false; this.recording.endedAt = this.clock(); this.recording.droppedEvents++;
          this.notify();
        }
        return;
      }
      this.storage.setItem(RECORDING_KEY, raw);
    } catch {
      // Stop in memory without recursively retrying a failed storage write.
      const r = this.recording;
      if (r.active) {
        this.append("session-stopped", "application", { reason: "storage-failure" }, undefined, true);
        r.active = false; r.endedAt = this.clock(); this.notify();
      }
    }
  }
  newGame() {
    if (!this.active) return;
    this.recording!.gameId = this.uuid(); this.lastLive = null;
    this.append("new-game", "player");
  }
  observeManual(before: ManualGameState, after: ManualGameState) {
    if (!this.active) return;
    try {
      const previous = stateSchema.parse(before), next = stateSchema.parse(after);
      if (same(previous, next)) return;
      const fields = Object.keys(next).filter((k) => !same(previous[k as keyof typeof previous], next[k as keyof typeof next]));
      // champion removal is absent from Object.keys(next).
      if (previous.championId !== next.championId && !fields.includes("championId")) fields.push("championId");
      this.append("manual-state-changed", "player", { state: next, fields });
      next.offeredAugments.forEach((a, i) => {
        const old = previous.offeredAugments[i];
        if (same(a, old)) return;
        this.append("offer-slot-changed", "player", { slot: i + 1, before: old, after: a });
        if (old && a && old.augmentId !== a.augmentId) this.append("inferred-offer-replacement", "app-inference", { slot: i + 1, before: old, after: a });
        if (old?.augmentId === a?.augmentId && old?.abilityContext !== a?.abilityContext) this.append("ability-context-changed", "player", { slot: i + 1, before: old, after: a });
      });
      for (const a of next.ownedAugments) {
        const old = previous.ownedAugments.find((p) => p.augmentId === a.augmentId);
        if (!old) this.append("augment-owned", "player", { augment: a });
        else if (old.abilityContext !== a.abilityContext) this.append("ability-context-changed", "player", { before: old, after: a });
      }
      for (const a of previous.ownedAugments) if (!next.ownedAugments.some((n) => n.augmentId === a.augmentId)) this.append("augment-removed", "player", { augment: a });
    } catch { this.event("capture-failure", { category: "capture-invalid" }); }
  }
  materialChangePending() {
    if (!this.active) return;
    for (const r of this.recording!.recommendations) if (r.outcome === "pending") this.event("material-change-pending", {}, r.requestId);
  }
  observeLive(view: LiveView) {
    if (!this.active) return;
    try {
      const transition = { status: view.enabled ? view.status : "disabled" as const, attached: view.attached, pendingAttachment: !!view.candidate };
      if (!same(transition, this.transition && JSON.parse(this.transition))) {
        this.transition = JSON.stringify(transition); this.append("live-transition", "live-sync", transition);
      }
      if (view.diagnostic) {
        const diagnostic = liveDiagnosticSchema.parse(view.diagnostic);
        const blocked = view.snapshot ? "existing-attachment-stale" as const : "initial-attachment" as const;
        const key = JSON.stringify({ diagnostic, blocked });
        if (key !== this.failure) { this.failure = key; this.append("live-failure", "live-sync", { diagnostic, blocked }); }
      } else this.failure = "";
      const s = view.snapshot;
      if (!view.attached || view.status !== "connected" || !s) return;
      const prev = this.lastLive;
      const structural = !prev || !same([s.championId, s.enemyChampionIds, s.inventory, s.mapNumber, s.gameMode],
        [prev.championId, prev.enemyChampionIds, prev.inventory, prev.mapNumber, prev.gameMode]);
      const statChange = prev && s.observedAt - prev.observedAt >= 30_000 &&
        Object.keys({ ...prev.stats, ...s.stats }).some((k) => {
          const a = prev.stats[k as keyof typeof prev.stats], b = s.stats[k as keyof typeof s.stats];
          return a === undefined || b === undefined ? a !== b : Math.abs(a - b) >= Math.max(k === "attackSpeed" ? 0.05 : 1, a * 0.05);
        });
      if (structural || statChange) {
        this.lastLive = s;
        this.append("live-applied", "live-sync", { state: { championId: s.championId, enemyChampionIds: s.enemyChampionIds,
          itemIds: s.inventory.map((i) => i.itemId), stats: s.stats, ownedAugments: [], offeredAugments: [null, null, null] },
          fields: ["championId", "enemyChampionIds", "itemIds", "stats"], observedAt: s.observedAt, gameTime: s.gameTime,
          gameMode: s.gameMode, mapNumber: s.mapNumber, inventory: s.inventory });
        // The UI's stale-result key intentionally ignores live stat fluctuations.
        // Sampled material stat changes are still evidence while work is pending.
        if (statChange && !structural) this.materialChangePending();
      }
      const warningKey = JSON.stringify(s.warnings);
      if (warningKey !== this.warningKey) { this.warningKey = warningKey; if (s.warnings.length || prev) this.append("live-warnings", "live-sync", { warnings: s.warnings }); }
    } catch { this.event("capture-failure", { category: "capture-invalid" }); }
  }
  requested(kind: "augment" | "item"): string | undefined {
    if (!this.active) return undefined;
    const r = this.recording!;
    if (r.recommendations.length >= LIMITS.recommendations) { this.stop("retention-limit"); return undefined; }
    const requestId = this.uuid();
    r.recommendations.push({ requestId, gameId: r.gameId, kind, requestedAt: this.clock(), outcome: "pending", disposition: "pending" });
    this.size += 300;
    this.event("recommendation-requested", { kind }, requestId);
    return requestId;
  }
  submitted(requestId: string | undefined, state: ManualGameState) {
    if (!this.active || !requestId) return;
    const req = this.recording!.recommendations.find((r) => r.requestId === requestId);
    if (!req) return;
    try {
      const safe = stateSchema.parse(state), added = bytes(safe);
      if (this.size + added > LIMITS.bytes - 4096) { this.recording!.droppedEvents++; this.stop("retention-limit"); return; }
      req.submittedState = safe; this.size += added; this.event("recommendation-submitted", {}, requestId);
    }
    catch { this.event("capture-failure", { category: "capture-invalid" }, requestId); }
  }
  completed(requestId: string | undefined, payload: unknown, httpStatus: number, elapsedMs: number) {
    if (!this.active || !requestId) return;
    const recording = this.recording!;
    const req = recording.recommendations.find((r) => r.requestId === requestId);
    if (!req || req.outcome !== "pending") return;
    try {
      const body = payload as { ok?: boolean; recommendation?: unknown; diagnostics?: unknown; error?: { code?: unknown } };
      const parsed = serverDiagnosticsSchema.safeParse(body?.diagnostics);
      let additions: Partial<typeof req> = {};
      let catalog: Recording["candidateCatalogs"][number] | undefined;
      if (parsed.success && parsed.data.requestId === requestId) {
        const { evidence, ...diagnostics } = parsed.data;
        additions.diagnostics = diagnostics;
        if (diagnostics.captureIncomplete || (body?.ok === true && !evidence)) {
          recording.droppedEvents++;
          this.event("capture-failure", { category: "capture-invalid" }, requestId);
        }
        if (evidence) {
          additions.snapshot = evidence.snapshot; additions.candidateAugmentIds = evidence.candidateAugmentIds;
          if (evidence.candidateItems) {
            const existing = recording.candidateCatalogs.find((c) => same(c.items, evidence.candidateItems));
            const ref = existing?.ref ?? `items-${recording.candidateCatalogs.length + 1}`;
            additions.candidateCatalogRef = ref;
            if (!existing) catalog = { ref, items: evidence.candidateItems };
          }
        }
      } else this.event("capture-failure", { category: parsed.success ? "correlation-mismatch" : "capture-invalid" }, requestId);
      const success = body?.ok === true && httpStatus >= 200 && httpStatus < 300;
      if (success) additions.result = resultSchema.parse(body.recommendation);
      const added = bytes(additions) + (catalog ? bytes(catalog) : 0) + 1024;
      if (this.size + added > LIMITS.bytes - 4096) { recording.droppedEvents++; this.stop("retention-limit"); return; }
      if (catalog) recording.candidateCatalogs.push(catalog);
      Object.assign(req, additions, { completedAt: this.clock(), elapsedMs, httpStatus, outcome: success ? "success" : "failed", disposition: "not-displayed" });
      this.size += added;
      const category = ["INVALID_REQUEST", "NOT_CONFIGURED", "PROVIDER_ERROR", "INVALID_MODEL_RESPONSE"].find((c) => c === body?.error?.code) as EventData["category"];
      if (!success) req.category = category ?? "network";
      this.event(success ? "recommendation-completed" : "recommendation-failed", { httpStatus, elapsedMs, ...(success ? {} : { category: category ?? "network" }) }, requestId);
    } catch { this.failed(requestId, "network", elapsedMs); }
  }
  failed(requestId: string | undefined, category: "network" | "live-preflight", elapsedMs: number) {
    if (!this.active || !requestId) return;
    const r = this.recording!.recommendations.find((r) => r.requestId === requestId);
    if (!r || r.outcome !== "pending") return;
    Object.assign(r, { outcome: "failed", disposition: "not-displayed", category, completedAt: this.clock(), elapsedMs });
    this.event("recommendation-failed", { category, elapsedMs }, requestId);
  }
  disposition(requestId: string | undefined, value: "stale" | "displayed") {
    if (!this.active || !requestId) return;
    const r = this.recording!.recommendations.find((r) => r.requestId === requestId);
    if (!r || r.disposition === value) return;
    r.disposition = value;
    this.event(value === "stale" ? "recommendation-stale" : "recommendation-displayed", {}, requestId);
  }
  exportBundle() {
    if (!this.recording) return null;
    this.flush();
    // Re-project persisted and in-memory data at the export trust boundary.
    const r = recordingSchema.parse(this.recording);
    const completed = r.recommendations.filter((q) => q.completedAt !== undefined);
    const latencies = completed.map((q) => q.elapsedMs ?? 0);
    const attempts = r.recommendations.flatMap((q) => q.diagnostics?.attempts ?? []);
    let attached = false, attachmentTransitions = 0;
    for (const event of r.events) if (event.type === "live-transition") {
      const next = event.data.attached === true;
      if (next !== attached) attachmentTransitions++;
      attached = next;
    }
    const tokens = (key: "inputTokens" | "outputTokens" | "reasoningTokens" | "cachedInputTokens" | "totalTokens") => {
      const values = attempts.flatMap((a) => a[key] === null ? [] : [a[key]]);
      return values.length ? values.reduce((a, b) => a + b, 0) : null;
    };
    return bundleSchema.parse({ ...r, exportedAt: this.clock(), summary: {
      augmentRequests: r.recommendations.filter((q) => q.kind === "augment").length,
      itemRequests: r.recommendations.filter((q) => q.kind === "item").length,
      successfulRequests: r.recommendations.filter((q) => q.outcome === "success").length,
      failedRequests: r.recommendations.filter((q) => q.outcome === "failed").length,
      interruptedRequests: r.recommendations.filter((q) => q.outcome === "interrupted").length,
      staleResults: r.recommendations.filter((q) => q.disposition === "stale").length,
      averageRequestLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
      maxRequestLatencyMs: latencies.length ? Math.max(...latencies) : null,
      totalServerLatencyMs: r.recommendations.reduce((n, q) => n + (q.diagnostics?.elapsedMs ?? 0), 0),
      totalProviderAttemptMs: attempts.reduce((n, a) => n + a.elapsedMs, 0),
      providerAttempts: attempts.length, inputTokens: tokens("inputTokens"), outputTokens: tokens("outputTokens"),
      reasoningTokens: tokens("reasoningTokens"), cachedInputTokens: tokens("cachedInputTokens"), totalTokens: tokens("totalTokens"),
      offerReplacements: r.events.filter((e) => e.type === "inferred-offer-replacement").length,
      ownedSelections: r.events.filter((e) => e.type === "augment-owned").length,
      liveFailures: r.events.filter((e) => e.type === "live-failure").length,
      attachmentTransitions, liveTransitions: r.events.filter((e) => e.type === "live-transition").length,
    } });
  }
}
