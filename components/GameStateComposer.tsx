"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { Augment, Champion, Item } from "@/lib/catalog";
import {
  createEmptyGameState,
  hasGameState,
  parseStoredGameState,
  recordOfferedAugment,
  serializeGameState,
  STORAGE_KEY,
  type AbilityContext,
  type ManualGameState,
  type PlayerStats,
  type SelectedAugment,
} from "@/lib/game-state";
import {
  buildRecommendationSnapshot,
  type RecommendationCatalog,
} from "@/lib/preprocess-game-state";
import type {
  RecommendationApiResponse,
  RecommendationApiSuccess,
} from "@/lib/recommendation/api-contract";
import type { RecommendationResponse } from "@/lib/recommendation-contract";
import { SearchSelect, type SearchOption } from "./SearchSelect";
import { useLiveSync } from "./useLiveSync";
import { isLiveFresh, LIVE_STALE_MS, liveRecommendationProblem, mergeLiveState, replaceOfferedAugment } from "@/lib/live-state";
import { RecommendationRequestLifecycle, recommendationStateKey } from "@/lib/recommendation/request-lifecycle";
import { SessionRecorder } from "@/lib/diagnostics/recorder";

type GameStateComposerProps = {
  champions: Champion[];
  augments: Augment[];
  items: Item[];
  patch: string;
  generatedAt: string;
};

const ABILITY_CONTEXTS: AbilityContext[] = ["Q", "W", "E", "R", "Passive"];

const STAT_FIELDS: Array<{
  key: keyof PlayerStats;
  label: string;
  placeholder: string;
  step?: string;
}> = [
  { key: "critChance", label: "Crit %", placeholder: "e.g. 100" },
  { key: "attackSpeed", label: "Attack speed", placeholder: "e.g. 1.8", step: "0.01" },
  { key: "attackDamage", label: "AD", placeholder: "e.g. 240" },
  { key: "abilityPower", label: "AP", placeholder: "e.g. 420" },
  { key: "armor", label: "Armor", placeholder: "e.g. 130" },
  { key: "magicResistance", label: "MR", placeholder: "e.g. 95" },
  { key: "abilityHaste", label: "Ability haste", placeholder: "e.g. 80" },
  { key: "health", label: "Health", placeholder: "e.g. 3500" },
];

type RecommendationUiState =
  | { status: "idle" }
  | { status: "outdated" }
  | { status: "loading"; kind: "augment" | "item" }
  | { status: "success"; recommendation: RecommendationResponse }
  | { status: "error"; kind: "augment" | "item"; message: string };

function AbilityContextPicker({
  value,
  onChange,
}: {
  value?: AbilityContext;
  onChange: (value?: AbilityContext) => void;
}) {
  const isCustom = Boolean(value && !ABILITY_CONTEXTS.includes(value));
  return (
    <div className="ability-context">
      <span>Affected ability</span>
      <div className="ability-buttons">
        {ABILITY_CONTEXTS.map((context) => (
          <button
            type="button"
            key={context}
            className={value === context ? "is-selected" : ""}
            aria-pressed={value === context}
            onClick={() => onChange(value === context ? undefined : context)}
          >
            {context === "Passive" ? "P" : context}
          </button>
        ))}
        <input
          aria-label="Custom affected ability context"
          value={isCustom ? value : ""}
          placeholder="Other"
          onChange={(event) => onChange(event.target.value || undefined)}
        />
      </div>
    </div>
  );
}

function AugmentSummary({
  augment,
  selected,
  onContextChange,
  onRemove,
  onRecord,
}: {
  augment: Augment;
  selected: SelectedAugment;
  onContextChange: (value?: AbilityContext) => void;
  onRemove: () => void;
  onRecord?: () => void;
}) {
  return (
    <article className={`augment-card rarity-${augment.rarity}`}>
      <div className="augment-heading">
        <div>
          <strong>{augment.name}</strong>
          <span>{augment.rarity}</span>
        </div>
        <button className="icon-button" type="button" aria-label={`Remove ${augment.name}`} onClick={onRemove}>
          ×
        </button>
      </div>
      <p>{augment.description}</p>
      {augment.descriptionQuality === "usable-with-missing-detail" ? (
        <small className="quality-note">Some exact values are unavailable in the snapshot.</small>
      ) : null}
      {augment.requiresAbilityContext ? (
        <AbilityContextPicker value={selected.abilityContext} onChange={onContextChange} />
      ) : null}
      {onRecord ? (
        <button className="secondary-button" type="button" aria-label={`Record ${augment.name} as owned`} onClick={onRecord}>
          Record this pick
        </button>
      ) : null}
    </article>
  );
}

export function GameStateComposer({ champions, augments, items, patch, generatedAt }: GameStateComposerProps) {
  const [, recordingChanged] = useState(0);
  const recorderRef = useRef<SessionRecorder | null>(null);
  if (!recorderRef.current) recorderRef.current = new SessionRecorder({ changed: () => recordingChanged((n) => n + 1) });
  const recorder = recorderRef.current;
  const displayRequestId = useRef<string | undefined>(undefined);
  const [manualState, setManualState] = useState<ManualGameState>(createEmptyGameState);
  const manualRef = useRef(manualState);
  const live = useLiveSync();
  const state = useMemo(() => mergeLiveState(manualState, live.snapshot, live.fresh, live.now),
    [manualState, live.snapshot, live.fresh, live.now]);
  const lifecycle = useRef(new RecommendationRequestLifecycle());
  const materialKey = recommendationStateKey(manualState, live);
  const [hydrated, setHydrated] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [recommendationUi, setRecommendationUi] = useState<RecommendationUiState>({ status: "idle" });
  const [recommendationDebug, setRecommendationDebug] = useState<RecommendationApiSuccess["debug"] | null>(null);
  const [requestPending, setRequestPending] = useState(false);

  function currentMaterialKey() {
    return recommendationStateKey(manualRef.current, live.getCurrent());
  }

  function invalidateRecommendation() {
    setRecommendationUi((current) => current.status === "idle" ? current : { status: "outdated" });
    setRecommendationDebug(null);
  }

  // Update the ref synchronously so back-to-back edits/picks cannot use old state.
  function setState(update: ManualGameState | ((current: ManualGameState) => ManualGameState)) {
    const next = typeof update === "function" ? update(manualRef.current) : update;
    recorder.observeManual(manualRef.current, next);
    manualRef.current = next;
    if (lifecycle.current.observe(currentMaterialKey())) {
      recorder.materialChangePending();
      invalidateRecommendation();
    }
    setManualState(next);
  }

  const championById = useMemo(() => new Map(champions.map((entry) => [entry.id, entry])), [champions]);
  const augmentById = useMemo(() => new Map(augments.map((entry) => [entry.id, entry])), [augments]);
  const itemById = useMemo(() => new Map(items.map((entry) => [entry.id, entry])), [items]);
  const catalogIds = useMemo(
    () => ({
      championIds: new Set(championById.keys()),
      augmentIds: new Set(augmentById.keys()),
      itemIds: new Set(itemById.keys()),
    }),
    [augmentById, championById, itemById],
  );
  const recommendationCatalog = useMemo<RecommendationCatalog>(
    () => ({ champions, augments, items }),
    [augments, champions, items],
  );
  const snapshotResult = useMemo(() => {
    try {
      return {
        snapshot: buildRecommendationSnapshot(state, recommendationCatalog, { patch, generatedAt }),
        error: null,
      };
    } catch (error) {
      return {
        snapshot: null,
        error: error instanceof Error ? error.message : "Snapshot normalization failed.",
      };
    }
  }, [generatedAt, patch, recommendationCatalog, state]);

  useEffect(() => {
    setState(parseStoredGameState(window.localStorage.getItem(STORAGE_KEY), catalogIds));
    try { recorder.recover(window.localStorage); } catch { /* storage may be disabled */ }
    setHydrated(true);
  }, [catalogIds]);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, serializeGameState(manualState, patch));
  }, [hydrated, patch, manualState]);

  useEffect(() => {
    if (lifecycle.current.observe(materialKey)) {
      recorder.materialChangePending();
      invalidateRecommendation();
    }
  }, [materialKey]);

  useEffect(() => { recorder.observeLive(live); }, [live.enabled, live.attached, live.status, live.snapshot, live.candidate, live.diagnostic]);
  useEffect(() => {
    if (recommendationUi.status === "success") recorder.disposition(displayRequestId.current, "displayed");
  }, [recommendationUi]);
  useEffect(() => {
    const save = () => recorder.flush();
    const visibility = () => { if (document.visibilityState === "hidden") save(); };
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", visibility);
    return () => { save(); window.removeEventListener("pagehide", save); document.removeEventListener("visibilitychange", visibility); };
  }, []);

  function exportDiagnostics() {
    try {
      const bundle = recorder.exportBundle();
      if (!bundle) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = `mayhem-diagnostics-${bundle.sessionId}.json`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`Exported ${bundle.recommendations.length} requests, ${bundle.summary.failedRequests} failures. Average request latency: ${bundle.summary.averageRequestLatencyMs === null ? "unavailable" : Math.round(bundle.summary.averageRequestLatencyMs) + " ms"}.`);
    } catch { setNotice("Diagnostics could not be exported. Gameplay remains available."); }
  }

  const championOptions = useMemo<SearchOption[]>(
    () =>
      champions.map((champion) => ({
        id: champion.id,
        name: champion.name,
        subtitle: champion.title,
        searchText: `${champion.key} ${champion.tags.join(" ")}`,
        tone: "champion",
      })),
    [champions],
  );
  const augmentOptions = useMemo<SearchOption[]>(
    () =>
      augments.map((augment) => ({
        id: augment.id,
        name: augment.name,
        subtitle: `${augment.rarity} · ${augment.description}`,
        searchText: `${augment.internalName} ${augment.description}`,
        tone: augment.rarity,
      })),
    [augments],
  );
  const itemOptions = useMemo<SearchOption[]>(
    () =>
      items.map((item) => ({
        id: item.id,
        name: item.name,
        subtitle: `#${item.id} · ${item.gold.total}g${item.purchasable ? "" : " · transformed/non-shop"}`,
        searchText: `${item.plainText} ${item.tags.join(" ")}`,
        tone: "item",
      })),
    [items],
  );

  const selectedChampion = state.championId ? championById.get(state.championId) : undefined;
  const ownedIds = new Set(state.ownedAugments.map((selection) => selection.augmentId));
  const enemyIds = new Set(state.enemyChampionIds);
  if (state.championId) enemyIds.add(state.championId);

  function updateOwnedAugment(index: number, update: Partial<SelectedAugment>) {
    setState((current) => ({
      ...current,
      ownedAugments: current.ownedAugments.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...update } : entry,
      ),
    }));
  }

  function setOfferedAugment(index: number, selection: SelectedAugment | null) {
    setState((current) => replaceOfferedAugment(current, index, selection));
  }

  function recordPick(index: number) {
    setState((current) => recordOfferedAugment(current, index));
  }

  function recommendedPickAction(augmentId: number) {
    const index = state.offeredAugments.findIndex((entry) => entry?.augmentId === augmentId);
    if (index < 0 || ownedIds.has(augmentId)) return null;
    return (
      <button className="secondary-button" type="button"
        aria-label={`Record ${augmentById.get(augmentId)?.name} as owned`} onClick={() => recordPick(index)}>
        Record this pick
      </button>
    );
  }

  function resetGame() {
    if (hasGameState(state) && !window.confirm("Start a new game and clear the current state?")) return;
    window.localStorage.removeItem(STORAGE_KEY);
    recorder.newGame();
    lifecycle.current.reset();
    live.resetSession();
    setState(createEmptyGameState());
    setRecommendationUi({ status: "idle" });
    setRecommendationDebug(null);
    setNotice("New game started. Current selections were cleared.");
  }

  async function requestRecommendation(kind: "augment" | "item") {
    // Acquire before any state update or await: React loading state is not a lock.
    const token = lifecycle.current.start(currentMaterialKey());
    if (!token) { recorder.event("recommendation-overlap-prevented", { kind }); return; }
    const diagnosticRequestId = recorder.requested(kind);
    const requestStarted = Date.now();
    setRequestPending(true);
    setRecommendationUi({ status: "loading", kind });
    setRecommendationDebug(null);
    try {
      let requestState = manualRef.current;
      if (live.enabled) {
        // Join any existing poll; never issue a second concurrent live request.
        const latest = live.fresh && isLiveFresh(live.snapshot, Date.now()) ? live : await live.refresh();
        if (!lifecycle.current.isCurrent(token, currentMaterialKey())) {
          recorder.failed(diagnosticRequestId, "live-preflight", Date.now() - requestStarted);
          recorder.disposition(diagnosticRequestId, "stale"); return;
        }
        const attached = latest.enabled && latest.candidate === null && latest.status === "connected";
        const problem = liveRecommendationProblem(latest.snapshot, attached, Date.now());
        if (problem) {
          recorder.failed(diagnosticRequestId, "live-preflight", Date.now() - requestStarted);
          setRecommendationUi({ status: "error", kind, message: problem });
          return;
        }
        requestState = mergeLiveState(manualRef.current, latest.snapshot, true, Date.now());
      }
      recorder.submitted(diagnosticRequestId, requestState);
      const response = await fetch("/api/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, state: requestState, ...(diagnosticRequestId ? { diagnosticRequestId } : {}) }),
      });
      const payload = (await response.json()) as RecommendationApiResponse;
      recorder.completed(diagnosticRequestId, payload, response.status, Date.now() - requestStarted);
      if (!lifecycle.current.isCurrent(token, currentMaterialKey())) {
        recorder.disposition(diagnosticRequestId, "stale"); return;
      }
      if (!response.ok || !payload.ok) {
        const message = payload.ok ? "Recommendation failed." : payload.error.message;
        setRecommendationUi({ status: "error", kind, message });
        return;
      }
      setRecommendationDebug(payload.debug);
      displayRequestId.current = diagnosticRequestId;
      setRecommendationUi({ status: "success", recommendation: payload.recommendation });
    } catch {
      recorder.failed(diagnosticRequestId, "network", Date.now() - requestStarted);
      if (!lifecycle.current.isCurrent(token, currentMaterialKey())) {
        recorder.disposition(diagnosticRequestId, "stale"); return;
      }
      setRecommendationUi({
        status: "error",
        kind,
        message: "Could not reach the local recommendation endpoint. Check the dev server and retry.",
      });
    } finally {
      lifecycle.current.finish(token);
      setRequestPending(false);
      setRecommendationUi((current) => current.status === "loading" ? { status: "outdated" } : current);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">ARAM MAYHEM · {live.fresh ? "LIVE STATE" : "MANUAL STATE"}</p>
          <h1>Mayhem Lab</h1>
        </div>
        <div className="header-actions">
          <div className="save-state" aria-live="polite">
            <span className={hydrated ? "save-dot is-ready" : "save-dot"} />
            {hydrated ? "Saved locally" : "Loading state…"}
          </div>
          <button className="secondary-button danger" type="button" onClick={resetGame}>
            New Game
          </button>
        </div>
      </header>

      <section className="live-sync panel" aria-label="Local session diagnostics">
        <div className="live-sync-heading">
          <strong role="status">{recorder.active ? "● " : ""}{recorder.status}</strong>
          {!recorder.hasRecording ? <button className="secondary-button" type="button" disabled={!hydrated || requestPending}
            onClick={() => recorder.start(manualRef.current, { patch, generatedAt }, live)}>Start recording</button> : null}
          {recorder.active ? <button className="secondary-button" type="button" onClick={() => recorder.stop()}>Stop recording</button> : null}
          {recorder.hasRecording ? <>
            <button className="secondary-button" type="button" onClick={exportDiagnostics}>Export Session Diagnostics</button>
            <button className="text-button" type="button" onClick={() => {
              if (!recorder.discard()) setNotice("Recording cleared from memory, but browser storage refused deletion. Remove this site's stored data to finish discarding it.");
            }}>Discard recording</button>
          </> : null}
        </div>
        <small>Opt-in · stored only in this browser · no automatic uploads. One recording, up to 2000 events, 80 requests or 4 MiB; capture stops at a limit. Export before discarding to start another recording.</small>
      </section>

      <section className="live-sync panel" aria-label="Live Sync">
        <div className="live-sync-heading">
          <label>
            <input type="checkbox" checked={live.enabled} disabled={!hydrated}
              onChange={(event) => live.setEnabled(event.target.checked)} />
            Live Sync
          </label>
          <strong role="status">{live.enabled ? live.status : "Manual entry"}</strong>
        </div>
        <p>{live.enabled ? live.message : "Enable to import your champion, enemies, inventory and stats. Augments and crit stay manual."}</p>
        {live.enabled ? <p>Disable Live Sync at any time to return to your saved manual fields.</p> : null}
        {live.enabled && live.candidate ? (
          <div className="live-attachment">
            <p>Detected {championById.get(live.candidate.championId)?.name} · {live.candidate.gameMode} · {Math.floor(live.candidate.gameTime / 60)} min.</p>
            <p>Confirm you are playing ARAM Mayhem and that the current {manualState.ownedAugments.length} owned augments and {manualState.offeredAugments.filter(Boolean).length} offers belong to this game. Otherwise use New Game first.</p>
            <button className="secondary-button" type="button" onClick={live.attach}
              disabled={live.status !== "waiting" || Date.now() - live.candidate.observedAt >= LIVE_STALE_MS}>
              Confirm Mayhem and use current selections
            </button>
          </div>
        ) : null}
        {live.enabled && live.snapshot ? <small>Last observation: {new Date(live.snapshot.observedAt).toLocaleTimeString()}</small> : null}
        {live.enabled && live.snapshot?.warnings.length ? <ul>{live.snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
      </section>

      {notice ? (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      ) : null}

      <div className="dashboard-grid">
        <section className="panel champion-panel">
          <div className="section-heading">
            <div>
              <span className="step">01</span>
              <h2>Champion</h2>
            </div>
            <small>Required later</small>
          </div>
          {selectedChampion ? (
            <div className="selected-primary">
              <div className="initials">{selectedChampion.name.slice(0, 2).toUpperCase()}</div>
              <div>
                <strong>{selectedChampion.name}</strong>
                <span>{selectedChampion.title}</span>
              </div>
              <button
                className="text-button"
                type="button"
                disabled={live.enabled}
                onClick={() => setState((current) => ({ ...current, championId: undefined }))}
              >
                Clear
              </button>
            </div>
          ) : null}
          <SearchSelect
            label="Champion"
            disabled={live.enabled}
            options={championOptions}
            placeholder={selectedChampion ? "Replace champion…" : "Search champion…"}
            onSelect={(championId) => setState((current) => ({ ...current, championId }))}
          />
        </section>

        <section className="panel enemy-panel">
          <div className="section-heading">
            <div>
              <span className="step">02</span>
              <h2>Enemy Team</h2>
            </div>
            <small>{state.enemyChampionIds.length}/5</small>
          </div>
          <div className="compact-chips">
            {state.enemyChampionIds.map((id) => {
              const champion = championById.get(id);
              return champion ? (
                <button
                  type="button"
                  className="chip"
                  disabled={live.enabled}
                  key={id}
                  title={`Remove ${champion.name}`}
                  onClick={() =>
                    setState((current) => ({
                      ...current,
                      enemyChampionIds: current.enemyChampionIds.filter((championId) => championId !== id),
                    }))
                  }
                >
                  {champion.name} <span>×</span>
                </button>
              ) : null;
            })}
          </div>
          <SearchSelect
            label="Enemy champion"
            options={championOptions}
            placeholder={state.enemyChampionIds.length < 5 ? "Add enemy champion…" : "Enemy team full"}
            disabled={live.enabled || state.enemyChampionIds.length >= 5}
            excludeIds={enemyIds}
            onSelect={(championId) =>
              setState((current) => ({
                ...current,
                enemyChampionIds: [...current.enemyChampionIds, championId].slice(0, 5),
              }))
            }
          />
        </section>

        <section className="panel owned-panel">
          <div className="section-heading">
            <div>
              <span className="step">03</span>
              <h2>Owned Augments</h2>
            </div>
            <small>{state.ownedAugments.length} selected</small>
          </div>
          <SearchSelect
            label="Owned augment"
            options={augmentOptions}
            placeholder="Search and add owned augment…"
            excludeIds={ownedIds}
            onSelect={(augmentId) =>
              setState((current) => ({
                ...current,
                ownedAugments: [...current.ownedAugments, { augmentId }],
              }))
            }
          />
          <div className="augment-list">
            {state.ownedAugments.map((selection, index) => {
              const augment = augmentById.get(selection.augmentId);
              return augment ? (
                <AugmentSummary
                  key={augment.id}
                  augment={augment}
                  selected={selection}
                  onContextChange={(abilityContext) => updateOwnedAugment(index, { abilityContext })}
                  onRemove={() =>
                    setState((current) => ({
                      ...current,
                      ownedAugments: current.ownedAugments.filter((_, entryIndex) => entryIndex !== index),
                    }))
                  }
                />
              ) : null;
            })}
            {!state.ownedAugments.length ? <p className="empty-state">No owned augments added yet.</p> : null}
          </div>
        </section>

        <section className="panel offered-panel">
          <div className="section-heading">
            <div>
              <span className="step">04</span>
              <h2>Offered Augments</h2>
            </div>
            <small>Three independent reroll slots</small>
          </div>
          <div className="offer-grid">
            {state.offeredAugments.map((selection, index) => {
              const augment = selection ? augmentById.get(selection.augmentId) : undefined;
              const otherOfferIds = new Set(
                state.offeredAugments
                  .filter((_, offerIndex) => offerIndex !== index)
                  .map((entry) => entry?.augmentId)
                  .filter((id): id is number => typeof id === "number"),
              );
              return (
                <div className="offer-slot" key={index}>
                  <div className="slot-label">OFFER {index + 1}</div>
                  {augment && selection ? (
                    <AugmentSummary
                      augment={augment}
                      selected={selection}
                      onContextChange={(abilityContext) =>
                        setOfferedAugment(index, { ...selection, abilityContext })
                      }
                      onRemove={() => setOfferedAugment(index, null)}
                      onRecord={ownedIds.has(augment.id) ? undefined : () => recordPick(index)}
                    />
                  ) : (
                    <div className="empty-offer">Empty slot</div>
                  )}
                  <SearchSelect
                    label={`Offered augment ${index + 1}`}
                    options={augmentOptions}
                    excludeIds={otherOfferIds}
                    placeholder={augment ? "Replace this offer…" : "Search augment…"}
                    onSelect={(augmentId) => setOfferedAugment(index, { augmentId })}
                  />
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel items-panel">
          <div className="section-heading">
            <div>
              <span className="step">05</span>
              <h2>Current Items</h2>
            </div>
            <small>{state.itemIds.length}/6</small>
          </div>
          <div className="item-grid">
            {state.itemIds.map((id, index) => {
              const item = itemById.get(id);
              return item ? (
                <button
                  className="item-chip"
                  disabled={live.enabled}
                  type="button"
                  key={`${id}-${index}`}
                  title={`Remove ${item.name}`}
                  onClick={() =>
                    setState((current) => ({
                      ...current,
                      itemIds: current.itemIds.filter((_, itemIndex) => itemIndex !== index),
                    }))
                  }
                >
                  <span>{item.name}</span>
                  <small>{live.fresh ? `Slot ${(live.snapshot?.inventory[index]?.slot ?? index) + 1} · ` : ""}{item.gold.total}g{live.fresh && (live.snapshot?.inventory[index]?.count ?? 1) > 1 ? ` · ×${live.snapshot?.inventory[index]?.count}` : ""}</small>
                  <b>×</b>
                </button>
              ) : <div className="item-chip unknown-item" key={`unknown-${id}-${index}`}><span>Unknown item #{id}</span><small>Occupied slot {(live.snapshot?.inventory[index]?.slot ?? index) + 1}</small></div>;
            })}
          </div>
          <SearchSelect
            label="Current item"
            options={itemOptions}
            placeholder={state.itemIds.length < 6 ? "Search and add item…" : "Inventory full"}
            disabled={live.enabled || state.itemIds.length >= 6}
            onSelect={(itemId) =>
              setState((current) => ({ ...current, itemIds: [...current.itemIds, itemId].slice(0, 6) }))
            }
          />
        </section>

        <section className="panel stats-panel">
          <div className="section-heading">
            <div>
              <span className="step">06</span>
              <h2>Current Stats</h2>
            </div>
            <small>Optional</small>
          </div>
          <div className="stats-grid">
            {STAT_FIELDS.map((field) => (
              <label key={field.key}>
                <span>{field.label}</span>
                <input
                  type="number"
                  disabled={live.enabled && field.key !== "critChance"}
                  min="0"
                  inputMode="decimal"
                  step={field.step ?? "1"}
                  value={state.stats[field.key] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(event) => {
                    const rawValue = event.target.value;
                    setState((current) => {
                      const stats = { ...current.stats };
                      if (!rawValue) delete stats[field.key];
                      else stats[field.key] = Number(rawValue);
                      return { ...current, stats };
                    });
                  }}
                />
              </label>
            ))}
          </div>
        </section>
      </div>

      <footer className="action-bar">
        <div>
          <strong>State ready when you are.</strong>
          <span>The model is constrained to the displayed offers or the filtered completed-item catalog.</span>
        </div>
        <div className="action-buttons">
          <button
            type="button"
            disabled={!hydrated || requestPending}
            onClick={() => requestRecommendation("augment")}
          >
            {recommendationUi.status === "loading" && recommendationUi.kind === "augment"
              ? "Choosing…"
              : "Choose Augment"}
          </button>
          <button
            type="button"
            disabled={!hydrated || requestPending}
            onClick={() => requestRecommendation("item")}
          >
            {recommendationUi.status === "loading" && recommendationUi.kind === "item"
              ? "Thinking…"
              : "Recommend Next Item"}
          </button>
        </div>
      </footer>

      {recommendationUi.status === "outdated" ? (
        <p className="notice" role="status">
          Game state changed. Request a new recommendation.
          {requestPending ? " The previous request is still finishing." : ""}
        </p>
      ) : null}
      {requestPending && recommendationUi.status === "idle" ? (
        <p className="notice" role="status">The previous request is still finishing.</p>
      ) : null}

      {recommendationUi.status === "error" ? (
        <section className="recommendation-error" role="alert">
          <div>
            <strong>Recommendation unavailable</strong>
            <p>{recommendationUi.message}</p>
          </div>
          <button type="button" disabled={requestPending} onClick={() => requestRecommendation(recommendationUi.kind)}>
            Retry
          </button>
        </section>
      ) : null}

      {recommendationUi.status === "success" ? (
        <section className="recommendation-panel" aria-live="polite">
          <div className="recommendation-title">
            <div>
              <span>{recommendationUi.recommendation.kind === "augment" ? "AUGMENT PICK" : "NEXT COMPLETED ITEM"}</span>
              <h2>{recommendationUi.recommendation.primary.name}</h2>
            </div>
            <b className={`confidence confidence-${recommendationUi.recommendation.confidence}`}>
              {recommendationUi.recommendation.confidence} confidence
            </b>
          </div>
          <p className="primary-reason">{recommendationUi.recommendation.primary.reason}</p>
          {recommendationUi.recommendation.kind === "augment"
            ? recommendedPickAction(recommendationUi.recommendation.primary.id) : null}
          {recommendationUi.recommendation.alternatives.length ? (
            <div className="recommendation-alternatives">
              {recommendationUi.recommendation.alternatives.map((alternative) => (
                <article key={alternative.id}>
                  <strong>{alternative.name}</strong>
                  <p>{alternative.reason}</p>
                  {alternative.preferWhen ? <small>Prefer when: {alternative.preferWhen}</small> : null}
                  {recommendationUi.recommendation.kind === "augment" ? recommendedPickAction(alternative.id) : null}
                </article>
              ))}
            </div>
          ) : null}
          {recommendationUi.recommendation.buildDirection ? (
            <p className="build-direction">
              <strong>Direction:</strong> {recommendationUi.recommendation.buildDirection}
            </p>
          ) : null}
          {recommendationUi.recommendation.warnings.length ? (
            <ul className="recommendation-warnings">
              {recommendationUi.recommendation.warnings.map((warning, index) => (
                <li key={`${warning}-${index}`}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <details className="debug-panel">
        <summary>
          <span>Recommendation debug</span>
          {snapshotResult.snapshot ? (
            <small>
              {snapshotResult.snapshot.facts.length} facts · {snapshotResult.snapshot.warnings.length} warnings
            </small>
          ) : (
            <small>normalization error</small>
          )}
        </summary>
        <p>Normalized state, exact candidate request, and validated structured result. Provider credentials are never included.</p>
        {snapshotResult.snapshot ? (
          <div className="debug-payloads">
            <h3>Current normalized snapshot</h3>
            <pre data-testid="recommendation-snapshot">
              {JSON.stringify(snapshotResult.snapshot, null, 2)}
            </pre>
            {recommendationDebug ? (
              <>
                <h3>
                  Last model request · {recommendationDebug.provider.provider}/{recommendationDebug.provider.model}
                </h3>
                <pre data-testid="recommendation-request">
                  {JSON.stringify(recommendationDebug.request, null, 2)}
                </pre>
              </>
            ) : null}
            {recommendationUi.status === "success" ? (
              <>
                <h3>Validated structured recommendation</h3>
                <pre data-testid="recommendation-response">
                  {JSON.stringify(recommendationUi.recommendation, null, 2)}
                </pre>
              </>
            ) : null}
          </div>
        ) : (
          <div className="snapshot-error" role="alert">
            {snapshotResult.error}
          </div>
        )}
      </details>

      <p className="data-footnote">
        Local snapshot {patch} · generated {new Date(generatedAt).toLocaleDateString("en-US")}
      </p>
    </main>
  );
}
