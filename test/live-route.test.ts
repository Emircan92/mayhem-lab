import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { GET } from "../app/api/live-state/route";
import { readLiveEndpoint } from "../lib/live-client/transport";
import { RIOT_ROOT_CA } from "../lib/live-client/riot-root";

const active = { riotId: "Local#TAG", championStats: { attackSpeed: 1.5, attackDamage: 100,
  abilityPower: 10, armor: 50, magicResist: 40, abilityHaste: 20, maxHealth: 1500, critChance: 25 } };
const championKeys = ["MonkeyKing", "Annie", "Ahri", "Ashe", "Aatrox", "Garen", "Lux", "Sona", "Volibear", "Vayne"];
const players = championKeys.map((key, index) => ({ riotId: index ? `Player${index}#TAG` : "Local#TAG",
  rawChampionName: `game_character_displayname_${key}`, team: index < 5 ? "ORDER" : "CHAOS",
  items: index ? [] : [{ itemID: 999999, slot: 0, count: 1 }] }));
const localRequest = () => new Request("http://127.0.0.1:3000/api/live-state", {
  headers: { host: "127.0.0.1:3000", "x-mayhem-live": "1", origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-origin" },
});

function upstream(t: TestContext, handler: (options: https.RequestOptions) => { status?: number; body?: string; error?: string; hang?: boolean }) {
  const calls: https.RequestOptions[] = [];
  t.mock.method(https, "get", (options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
    calls.push(options);
    const request = new EventEmitter();
    const result = handler(options);
    queueMicrotask(() => {
      if (result.hang) {
        options.signal?.addEventListener("abort", () => request.emit("error", Object.assign(new Error("timeout"), { code: "ABORT_ERR" })), { once: true });
      } else if (result.error) request.emit("error", Object.assign(new Error("private upstream details"), { code: result.error }));
      else {
        const stream = new PassThrough() as unknown as IncomingMessage;
        stream.statusCode = result.status ?? 200;
        callback(stream);
        (stream as unknown as PassThrough).end(result.body ?? "{}");
      }
    });
    return request;
  });
  return calls;
}

test("route normalizes fixture data and unknown inventory, validates TLS, and returns no-store without identifiers", async (t) => {
  const calls = upstream(t, (options) => ({ body: JSON.stringify(options.path?.endsWith("activeplayer") ? active
    : options.path?.endsWith("playerlist") ? players : { gameTime: 120, gameMode: "ARAM", mapNumber: 12 }) }));
  const globalAgent = https.globalAgent;
  const response = await GET(localRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.championId, 62);
  assert.equal(result.snapshot.inventory[0].known, false);
  assert.equal(result.snapshot.stats.health, 1500);
  assert.equal(result.snapshot.stats.critChance, undefined);
  assert.doesNotMatch(JSON.stringify(result), /Local#TAG|Player1|championStats/);
  assert.equal(calls.length, 3);
  for (const options of calls) {
    assert.equal(options.hostname, "127.0.0.1"); assert.equal(options.port, 2999);
    assert.equal(options.ca, RIOT_ROOT_CA); assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.agent, false); assert.equal(options.method, "GET");
    assert.ok(options.signal);
  }
  assert.equal(https.globalAgent, globalAgent);
});

test("route rejects cross-site access before making any upstream request", async (t) => {
  const calls = upstream(t, () => ({ error: "ECONNREFUSED" }));
  const response = await GET(new Request("http://127.0.0.1:3000/api/live-state", {
    headers: { host: "127.0.0.1:3000", "x-mayhem-live": "1", origin: "https://attacker.test" },
  }));
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls.length, 0);
});

test("incompatible games are unavailable and connection refusal is waiting", async (t) => {
  let offline = false;
  upstream(t, (options) => offline ? { error: "ECONNREFUSED" } : { body: JSON.stringify(
    options.path?.endsWith("activeplayer") ? active : options.path?.endsWith("playerlist") ? players
      : { gameTime: 100, gameMode: "CLASSIC", mapNumber: 11 }) });
  const incompatible = await (await GET(localRequest())).json();
  assert.equal(incompatible.ok, false); assert.equal(incompatible.status, "unavailable");
  offline = true;
  const waiting = await (await GET(localRequest())).json();
  assert.equal(waiting.status, "waiting");
  assert.doesNotMatch(JSON.stringify(waiting), /private upstream/);
});

test("upstream redirects, malformed JSON and oversized responses fail closed", async (t) => {
  let result = { status: 302, body: "{}" };
  const calls = upstream(t, () => result);
  await assert.rejects(readLiveEndpoint("game"), /not providing/);
  assert.equal(calls.length, 1); // No redirect follow-up.
  result = { status: 200, body: "not json" };
  await assert.rejects(readLiveEndpoint("game"), /invalid live data/);
  result = { status: 200, body: "x".repeat(256 * 1024 + 1) };
  await assert.rejects(readLiveEndpoint("game"), /size limit/);
});

test("an unresponsive upstream is aborted by the absolute request deadline", async (t) => {
  upstream(t, () => ({ hang: true }));
  // A ref'ed timer keeps this simulated socket alive, as a real socket would.
  const keepAlive = setInterval(() => {}, 100);
  try { await assert.rejects(readLiveEndpoint("game"), /did not respond in time/); }
  finally { clearInterval(keepAlive); }
});
