import champions from "@/data/generated/16.19.1/champions.json";
import items from "@/data/generated/16.19.1/items.json";
import { allowLiveRequest } from "@/lib/live-client/access";
import { LiveDataError, normalizeLiveState } from "@/lib/live-client/normalize";
import { LiveTransportError, readLiveClient } from "@/lib/live-client/transport";
import type { LiveStateResponse } from "@/lib/live-state";
import manifest from "@/data/generated/16.19.1/manifest.json";
import { liveDiagnosticSchema } from "@/lib/diagnostics/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function reply(body: LiveStateResponse, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "Vary": "Origin, Sec-Fetch-Site" } });
}

export async function GET(request: Request) {
  if (!allowLiveRequest(request)) {
    return reply({ ok: false, status: "unavailable", message: "Live Sync is restricted to the local Mayhem Lab page." }, 403);
  }
  try {
    const snapshot = normalizeLiveState(await readLiveClient(), { champions: champions.champions, items: items.items });
    if (snapshot.mapNumber !== 12) {
      return reply({ ok: false, status: "unavailable", diagnostic: { category: "incompatible-map" }, message: "This game is on an incompatible map. Live Sync requires an explicitly confirmed ARAM Mayhem game." });
    }
    return reply({ ok: true, snapshot });
  } catch (error) {
    if (error instanceof LiveTransportError) return reply({ ok: false, status: error.status, message: error.message, diagnostic: { category: "transport" } });
    if (error instanceof LiveDataError) return reply({ ok: false, status: "unavailable", message: error.message,
      diagnostic: liveDiagnosticSchema.parse({ ...error.diagnostic, patch: manifest.riotDataDragonPatch }) });
    return reply({ ok: false, status: "unavailable", diagnostic: { category: "unexpected" }, message: "Live data could not be read safely. Manual entry is still available." }, 503);
  }
}
