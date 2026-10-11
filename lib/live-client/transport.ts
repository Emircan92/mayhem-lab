import https from "node:https";
import { RIOT_ROOT_CA } from "./riot-root";

export class LiveTransportError extends Error {
  constructor(readonly status: "waiting" | "unavailable", message: string) { super(message); }
}

const PATHS = {
  activePlayer: "/liveclientdata/activeplayer",
  players: "/liveclientdata/playerlist",
  game: "/liveclientdata/gamestats",
} as const;

export function readLiveEndpoint(endpoint: keyof typeof PATHS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // https.get never follows redirects. agent:false also prevents global agent reuse.
    const request = https.get({
      hostname: "127.0.0.1", port: 2999, path: PATHS[endpoint], method: "GET",
      ca: RIOT_ROOT_CA, rejectUnauthorized: true, agent: false,
      signal: AbortSignal.timeout(1_800), headers: { Accept: "application/json" },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new LiveTransportError(response.statusCode === 404 ? "waiting" : "unavailable", "The game client is not providing live data."));
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) {
          response.destroy();
          reject(new LiveTransportError("unavailable", "The live response exceeded its size limit."));
        } else chunks.push(chunk);
      });
      response.on("error", () => reject(new LiveTransportError("unavailable", "The live response was interrupted.")));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new LiveTransportError("unavailable", "The game client returned invalid live data.")); }
      });
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") {
        reject(new LiveTransportError("waiting", "Waiting for a running game."));
      } else if (error.code === "ABORT_ERR") {
        reject(new LiveTransportError("unavailable", "The game client did not respond in time."));
      } else {
        reject(new LiveTransportError("unavailable", "Could not securely read the game client. Check its availability and Riot certificate."));
      }
    });
  });
}

export async function readLiveClient() {
  // Settle all requests before allowing the next polling cycle.
  const results = await Promise.allSettled([
    readLiveEndpoint("activePlayer"), readLiveEndpoint("players"), readLiveEndpoint("game"),
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return {
    activePlayer: (results[0] as PromiseFulfilledResult<unknown>).value,
    players: (results[1] as PromiseFulfilledResult<unknown>).value,
    game: (results[2] as PromiseFulfilledResult<unknown>).value,
  };
}
