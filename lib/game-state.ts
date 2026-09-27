export type AbilityContext = "Q" | "W" | "E" | "R" | "Passive" | (string & {});

export type SelectedAugment = {
  augmentId: number;
  abilityContext?: AbilityContext;
};

export type PlayerStats = {
  critChance?: number;
  attackSpeed?: number;
  attackDamage?: number;
  abilityPower?: number;
  armor?: number;
  magicResistance?: number;
  abilityHaste?: number;
  health?: number;
};

export type ManualGameState = {
  championId?: number;
  ownedAugments: SelectedAugment[];
  offeredAugments: [SelectedAugment | null, SelectedAugment | null, SelectedAugment | null];
  itemIds: number[];
  enemyChampionIds: number[];
  stats: PlayerStats;
};

export type CatalogIds = {
  championIds: ReadonlySet<number>;
  augmentIds: ReadonlySet<number>;
  itemIds: ReadonlySet<number>;
};

export type StoredGameState = {
  schemaVersion: 1;
  dataPatch: string;
  state: ManualGameState;
};

export const STORAGE_KEY = "mayhem-lab:manual-game-state:v1";

const STAT_KEYS: Array<keyof PlayerStats> = [
  "critChance",
  "attackSpeed",
  "attackDamage",
  "abilityPower",
  "armor",
  "magicResistance",
  "abilityHaste",
  "health",
];

export function createEmptyGameState(): ManualGameState {
  return {
    ownedAugments: [],
    offeredAugments: [null, null, null],
    itemIds: [],
    enemyChampionIds: [],
    stats: {},
  };
}

function selectedAugment(value: unknown, validIds: ReadonlySet<number>): SelectedAugment | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!Number.isInteger(candidate.augmentId) || !validIds.has(candidate.augmentId as number)) return null;
  return {
    augmentId: candidate.augmentId as number,
    ...(typeof candidate.abilityContext === "string" && candidate.abilityContext.trim()
      ? { abilityContext: candidate.abilityContext.trim() }
      : {}),
  };
}

export function parseStoredGameState(
  serialized: string | null,
  catalog: CatalogIds,
): ManualGameState {
  if (!serialized) return createEmptyGameState();

  try {
    const stored = JSON.parse(serialized) as Partial<StoredGameState>;
    if (stored.schemaVersion !== 1 || !stored.state || typeof stored.state !== "object") {
      return createEmptyGameState();
    }

    const state = stored.state as Partial<ManualGameState>;
    const ownedAugments = Array.isArray(state.ownedAugments)
      ? state.ownedAugments
          .map((entry) => selectedAugment(entry, catalog.augmentIds))
          .filter((entry): entry is SelectedAugment => entry !== null)
          .filter((entry, index, all) => all.findIndex((other) => other.augmentId === entry.augmentId) === index)
      : [];
    const offeredInput = Array.isArray(state.offeredAugments) ? state.offeredAugments : [];
    const offeredAugments: ManualGameState["offeredAugments"] = [0, 1, 2].map((index) =>
      selectedAugment(offeredInput[index], catalog.augmentIds),
    ) as ManualGameState["offeredAugments"];
    const itemIds = Array.isArray(state.itemIds)
      ? state.itemIds.filter((id): id is number => Number.isInteger(id) && catalog.itemIds.has(id as number)).slice(0, 6)
      : [];
    const enemyChampionIds = Array.isArray(state.enemyChampionIds)
      ? state.enemyChampionIds
          .filter((id): id is number => Number.isInteger(id) && catalog.championIds.has(id as number))
          .filter((id, index, all) => all.indexOf(id) === index)
          .slice(0, 5)
      : [];
    const stats: PlayerStats = {};
    if (state.stats && typeof state.stats === "object") {
      for (const key of STAT_KEYS) {
        const value = state.stats[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) stats[key] = value;
      }
    }

    return {
      ...(Number.isInteger(state.championId) && catalog.championIds.has(state.championId as number)
        ? { championId: state.championId }
        : {}),
      ownedAugments,
      offeredAugments,
      itemIds,
      enemyChampionIds,
      stats,
    };
  } catch {
    return createEmptyGameState();
  }
}

export function serializeGameState(state: ManualGameState, dataPatch: string): string {
  return JSON.stringify({ schemaVersion: 1, dataPatch, state } satisfies StoredGameState);
}

export function hasGameState(state: ManualGameState): boolean {
  return Boolean(
    state.championId ||
      state.ownedAugments.length ||
      state.offeredAugments.some(Boolean) ||
      state.itemIds.length ||
      state.enemyChampionIds.length ||
      Object.keys(state.stats).length,
  );
}
