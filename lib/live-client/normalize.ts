import { createHash } from "node:crypto";
import { z } from "zod";
import type { Champion, Item } from "../catalog";
import type { LiveSnapshot } from "../live-state";
import type { LiveDiagnostic } from "../diagnostics/schema";

export class LiveDataError extends Error {
  constructor(message: string, readonly diagnostic: LiveDiagnostic = { category: "normalization" }) { super(message); }
}

const identity = {
  riotId: z.string().min(1).optional(),
  riotIdGameName: z.string().min(1).optional(),
  riotIdTagLine: z.string().min(1).optional(),
  summonerName: z.string().min(1).optional(),
};
const activeSchema = z.object({ ...identity, championStats: z.record(z.string(), z.unknown()) });
const rosterSchema = z.array(z.object({
  ...identity,
  rawChampionName: z.string(),
  team: z.enum(["ORDER", "CHAOS"]),
  items: z.array(z.object({
    itemID: z.number().int().nonnegative(),
    slot: z.number().int().min(0).max(6),
    count: z.number().int().positive(),
  })).max(7),
})).length(10);
const gameSchema = z.object({
  gameTime: z.number().finite().nonnegative(),
  gameMode: z.string().min(1),
  mapNumber: z.number().int().positive(),
});

function fullId(player: z.infer<typeof activeSchema> | z.infer<typeof rosterSchema>[number]) {
  return player.riotId ?? (player.riotIdGameName && player.riotIdTagLine
    ? `${player.riotIdGameName}#${player.riotIdTagLine}` : undefined);
}

export function normalizeLiveState(
  input: { activePlayer: unknown; players: unknown; game: unknown },
  catalog: { champions: Pick<Champion, "id" | "key">[]; items: Pick<Item, "id">[] },
  observedAt = Date.now(),
): LiveSnapshot {
  const activeResult = activeSchema.safeParse(input.activePlayer);
  const rosterResult = rosterSchema.safeParse(input.players);
  const gameResult = gameSchema.safeParse(input.game);
  if (!activeResult.success || !rosterResult.success || !gameResult.success) {
    throw new LiveDataError("Live data is incomplete or has an unsupported shape.");
  }
  const active = activeResult.data, players = rosterResult.data, game = gameResult.data;
  const activeId = fullId(active);
  const matches = players.filter((player) => activeId
    ? fullId(player) === activeId
    : Boolean(active.summonerName && player.summonerName === active.summonerName));
  if (matches.length !== 1) throw new LiveDataError("The local player could not be identified unambiguously.");
  const local = matches[0];
  if (players.filter((player) => player.team === local.team).length !== 5) {
    throw new LiveDataError("The live team roster is incomplete.");
  }
  const championByKey = new Map(catalog.champions.map((champion) => [`game_character_displayname_${champion.key}`, champion.id]));
  function championId(player: typeof local) {
    const id = championByKey.get(player.rawChampionName);
    if (id === undefined) throw new LiveDataError("A live champion key is missing from the bundled catalog.", {
      category: "unknown-champion", role: player === local ? "local-player" : "enemy",
      // Retain the exact identity, never the player object or account identifiers.
      ...(player.rawChampionName.length <= 512 ? { rawChampionName: player.rawChampionName } : {}),
    });
    return id;
  }
  const enemyChampionIds = players.filter((player) => player.team !== local.team).map(championId);
  if (new Set(enemyChampionIds).size !== enemyChampionIds.length) {
    throw new LiveDataError("Repeated enemy champions are not supported by the current state model.");
  }
  const identities = players.map((player) => fullId(player) ?? player.summonerName);
  if (identities.some((id) => !id) || new Set(identities).size !== players.length) {
    throw new LiveDataError("The live roster identities are ambiguous.");
  }
  const itemIds = new Set(catalog.items.map((item) => item.id));
  const inventory = local.items.filter((item) => item.itemID !== 0 && item.slot < 6)
    .sort((a, b) => a.slot - b.slot)
    .map((item) => ({ slot: item.slot, itemId: item.itemID, count: item.count, known: itemIds.has(item.itemID) }));
  if (new Set(inventory.map((item) => item.slot)).size !== inventory.length) {
    throw new LiveDataError("The live inventory contains conflicting occupied slots.");
  }
  const stats: LiveSnapshot["stats"] = {};
  const warnings: string[] = [];
  const statMap = {
    attackSpeed: "attackSpeed", attackDamage: "attackDamage", abilityPower: "abilityPower",
    armor: "armor", magicResistance: "magicResist", abilityHaste: "abilityHaste", health: "maxHealth",
  } as const;
  for (const [target, source] of Object.entries(statMap)) {
    const value = active.championStats[source];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      stats[target as keyof typeof stats] = value;
    } else warnings.push(`${target} is unavailable or unsupported; it was not synchronized.`);
  }
  if (inventory.some((item) => !item.known)) warnings.push("Unknown inventory IDs require manual resolution before recommendations.");
  // Names are used only inside the server-side fingerprint, never returned or logged.
  // Champion forms are observations, not participant identity.
  const roster = players.map((player, index) => [identities[index], player.team]).sort();
  const sessionKey = createHash("sha256").update(JSON.stringify([activeId ?? active.summonerName, roster, game.gameMode, game.mapNumber])).digest("hex");
  return { ...game, observedAt, sessionKey, championId: championId(local), enemyChampionIds, inventory, stats, warnings };
}
