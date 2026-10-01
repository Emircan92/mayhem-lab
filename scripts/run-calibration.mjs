import { readFile } from "node:fs/promises";
import process from "node:process";

const fixturePath = process.argv[2];
if (!fixturePath) throw new Error("Usage: node scripts/run-calibration.mjs <fixture.json>");

const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const endpoint = process.env.MAYHEM_CALIBRATION_URL?.trim() || "http://localhost:3000/api/recommend";
const response = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(fixture.request),
});
const payload = await response.json();

if (!response.ok || !payload.ok) {
  console.error(JSON.stringify(payload, null, 2));
  process.exitCode = 1;
} else {
  const requestJson = JSON.stringify(payload.debug.request);
  const snapshotWithoutKits = structuredClone(payload.debug.request.snapshot);
  if (snapshotWithoutKits.champion) delete snapshotWithoutKits.champion.kit;
  for (const enemy of snapshotWithoutKits.enemies) delete enemy.kit;
  const requestWithoutKits = { ...payload.debug.request, snapshot: snapshotWithoutKits };
  const withoutKitBytes = Buffer.byteLength(JSON.stringify(requestWithoutKits));
  const requestBytes = Buffer.byteLength(requestJson);
  console.log(JSON.stringify({
    fixture: fixture.name,
    recommendation: payload.recommendation,
    requestSizeBytes: requestBytes,
    requestSizeWithoutKitsBytes: withoutKitBytes,
    kitContributionBytes: requestBytes - withoutKitBytes,
    provider: payload.debug.provider,
  }, null, 2));
}
