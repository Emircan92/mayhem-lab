import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyGameState, serializeGameState } from "../lib/game-state";
import { normalizeLiveState } from "../lib/live-client/normalize";
import { allowLiveRequest } from "../lib/live-client/access";
import { isLiveFresh, LIVE_STALE_MS, liveRecommendationProblem, mergeLiveState, receiveLiveSnapshot, replaceOfferedAugment, sameLiveGame } from "../lib/live-state";

const catalog = {
  champions: Array.from({ length: 10 }, (_, index) => ({ id: index + 1, key: index === 0 ? "MonkeyKing" : `Hero${index}` })),
  // Ownership includes non-shop/transformed IDs; no eligibility filter here.
  items: [{ id: 20 }, { id: 21 }],
};
function fixture() {
  return {
    activePlayer: {
      riotId: "Local#TAG", summonerName: "Legacy",
      championStats: { attackSpeed: 1.8, attackDamage: 240, abilityPower: 420, armor: 130,
        magicResist: 95, abilityHaste: 80, maxHealth: 3500, currentHealth: 100, critChance: 0.25 },
    },
    players: catalog.champions.map((champion, index) => ({
      riotId: index === 0 ? "Local#TAG" : `Player${index}#TAG`, summonerName: index === 0 ? "Legacy" : `Old${index}`,
      team: index < 5 ? "CHAOS" : "ORDER",
      rawChampionName: `game_character_displayname_${champion.key}`,
      items: index === 0 ? [
        { itemID: 20, slot: 4, count: 1 }, { itemID: 20, slot: 0, count: 1 },
        { itemID: 21, slot: 2, count: 3 }, { itemID: 3340, slot: 6, count: 1 },
      ] : [],
    })),
    game: { gameTime: 100, gameMode: "ARAM", mapNumber: 12 },
  };
}
const snapshot = () => normalizeLiveState(fixture(), catalog, 100_000);

test("exact keys and local team resolve champion and opposing roster, without exposing names", () => {
  const result = snapshot();
  assert.equal(result.championId, 1);
  assert.deepEqual(result.enemyChampionIds, [6, 7, 8, 9, 10]);
  assert.equal(result.sessionKey.length, 64);
  assert.doesNotMatch(JSON.stringify(result), /Local#TAG|Legacy|Player5/);
});

test("inventory preserves duplicate occupied slots, stack metadata, and full-catalog items", () => {
  assert.deepEqual(snapshot().inventory, [
    { slot: 0, itemId: 20, count: 1, known: true },
    { slot: 2, itemId: 21, count: 3, known: true },
    { slot: 4, itemId: 20, count: 1, known: true },
  ]);
  const input = fixture();
  input.players[0].items.push({ itemID: 999, slot: 5, count: 1 });
  const result = normalizeLiveState(input, catalog, 100_000);
  assert.deepEqual(result.inventory.at(-1), { slot: 5, itemId: 999, count: 1, known: false });
  assert.match(liveRecommendationProblem(result, true, 100_001)!, /unknown items/);
  assert.deepEqual(mergeLiveState(createEmptyGameState(), result, true, 100_001).itemIds, [20, 21, 20, 999]);
});

test("stats use max health, translate MR, and never import crit or substitute unsupported stats", () => {
  assert.deepEqual(snapshot().stats, { attackSpeed: 1.8, attackDamage: 240, abilityPower: 420, armor: 130,
    magicResistance: 95, abilityHaste: 80, health: 3500 });
  const input = fixture();
  input.activePlayer.championStats.armor = -5;
  const result = normalizeLiveState(input, catalog, 100_000);
  assert.equal(result.stats.armor, undefined);
  assert.match(result.warnings.join(" "), /armor/);
});

test("ambiguous identity and inconsistent rosters fail closed, without weaker-name fallback", () => {
  const duplicate = fixture();
  duplicate.players[1].riotId = duplicate.players[0].riotId;
  assert.throws(() => normalizeLiveState(duplicate, catalog), /unambiguously/);
  const wrong = fixture();
  wrong.activePlayer.riotId = "Missing#TAG";
  assert.throws(() => normalizeLiveState(wrong, catalog), /unambiguously/);
  const incomplete = fixture();
  incomplete.players.pop();
  assert.throws(() => normalizeLiveState(incomplete, catalog), /incomplete/);
  const unknown = fixture();
  unknown.players[0].rawChampionName = "Localized Wukong";
  assert.throws(() => normalizeLiveState(unknown, catalog), /champion key/);
  const conflicting = fixture();
  conflicting.players[0].items[1].slot = 4;
  assert.throws(() => normalizeLiveState(conflicting, catalog), /conflicting/);
});

test("structured Riot IDs and unique legacy names work when full IDs are absent", () => {
  const input = fixture();
  const active = input.activePlayer as typeof input.activePlayer & { riotIdGameName?: string; riotIdTagLine?: string };
  Reflect.deleteProperty(active, "riotId");
  active.riotIdGameName = "Local"; active.riotIdTagLine = "TAG";
  assert.equal(normalizeLiveState(input, catalog).championId, 1);
  Reflect.deleteProperty(active, "riotIdGameName"); Reflect.deleteProperty(active, "riotIdTagLine");
  assert.equal(normalizeLiveState(input, catalog).championId, 1);
  input.players[1].summonerName = "Legacy";
  assert.throws(() => normalizeLiveState(input, catalog), /unambiguously/);
});

test("merging preserves manual augments, contexts and crit, without persisting live fields", () => {
  const manual = { ...createEmptyGameState(), championId: 3, itemIds: [21], enemyChampionIds: [2],
    ownedAugments: [{ augmentId: 10, abilityContext: "Q" }],
    stats: { critChance: 75, health: 1000, armor: 44 } };
  manual.offeredAugments = [{ augmentId: 11, abilityContext: "R" }, null, { augmentId: 12, abilityContext: "E" }];
  const original = serializeGameState(manual, "test");
  const merged = mergeLiveState(manual, snapshot(), true, 100_100);
  assert.deepEqual(merged.itemIds, [20, 21, 20]);
  assert.equal(merged.stats.health, 3500);
  assert.equal(merged.stats.critChance, 75);
  assert.equal(merged.ownedAugments, manual.ownedAugments);
  assert.equal(merged.offeredAugments, manual.offeredAugments);
  assert.equal(serializeGameState(manual, "test"), original);
  assert.equal(mergeLiveState(manual, snapshot(), false, 100_100), manual);
});

test("stale, missing and future observations fall back to manual; live recommendations require fresh attachment", () => {
  const manual = createEmptyGameState();
  for (const now of [99_999, 100_000 + LIVE_STALE_MS]) {
    assert.equal(isLiveFresh(snapshot(), now), false);
    assert.equal(mergeLiveState(manual, snapshot(), true, now), manual);
    assert.match(liveRecommendationProblem(snapshot(), true, now)!, /stale/);
  }
  assert.equal(mergeLiveState(manual, null, true, 100_000), manual);
  assert.match(liveRecommendationProblem(snapshot(), false, 100_000)!, /Confirm/);
  assert.equal(liveRecommendationProblem(snapshot(), true, 100_000), null);
});

test("reroll replacement clears only its own context and preserves other slots and ownership", () => {
  const manual = createEmptyGameState();
  manual.ownedAugments = [{ augmentId: 10, abilityContext: "Q" }];
  manual.offeredAugments = [{ augmentId: 11, abilityContext: "R" }, { augmentId: 12, abilityContext: "W" }, null];
  const result = replaceOfferedAugment(manual, 1, { augmentId: 13 });
  assert.deepEqual(result.offeredAugments, [{ augmentId: 11, abilityContext: "R" }, { augmentId: 13 }, null]);
  assert.equal(result.ownedAugments, manual.ownedAugments);
  assert.equal(manual.offeredAugments[1]?.abilityContext, "W");
});

test("first attachment and ambiguous game boundaries remain pending until explicitly confirmed", () => {
  const previous = snapshot();
  assert.deepEqual(receiveLiveSnapshot({ snapshot: null, candidate: null }, previous), { snapshot: null, candidate: previous });
  const reconnect = { ...previous, observedAt: 130_000, gameTime: 130, inventory: [] };
  assert.equal(sameLiveGame(previous, reconnect), true);
  assert.equal(receiveLiveSnapshot({ snapshot: previous, candidate: null }, reconnect).candidate, null);
  const boundaries = [
    { ...reconnect, gameTime: 0 }, { ...reconnect, sessionKey: "another-roster" },
    { ...reconnect, gameMode: "KIWI" }, { ...reconnect, observedAt: 1_000_000 },
  ];
  for (const next of boundaries) {
    assert.equal(sameLiveGame(previous, next), false);
    const pending = receiveLiveSnapshot({ snapshot: previous, candidate: null }, next);
    assert.equal(pending.snapshot, previous);
    assert.equal(pending.candidate, next);
    assert.equal(receiveLiveSnapshot(pending, reconnect).candidate, reconnect);
  }
});

test("local endpoint rejects cross-site, sibling-port, DNS rebinding and simple requests", () => {
  const request = (headers: Record<string, string>, url = "http://127.0.0.1:3000/api/live-state") =>
    new Request(url, { headers: { host: "127.0.0.1:3000", "x-mayhem-live": "1", ...headers } });
  assert.equal(allowLiveRequest(request({ origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" })), true);
  assert.equal(allowLiveRequest(request({})), true); // Native local diagnostic request.
  assert.equal(allowLiveRequest(request({ origin: "http://127.0.0.1:3000" }, "http://localhost:3000/api/live-state")), true);
  const denied: Array<Record<string, string>> = [
    { origin: "https://attacker.test" }, { origin: "http://127.0.0.1:4000" },
    { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" },
    { "x-mayhem-live": "" }, { host: "attacker.test:3000" }, { origin: "null" },
  ];
  for (const headers of denied) assert.equal(allowLiveRequest(request(headers)), false);
  assert.equal(allowLiveRequest(request({ host: "attacker.test" }, "http://attacker.test/api/live-state")), false);
});
