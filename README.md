# Mayhem Lab

Mayhem Lab is a local-first ARAM Mayhem game-state composer with grounded augment and completed-item recommendations over the versioned champion, item, and `KIWI` augment snapshot.

## Run the app

Node.js 20.9 or newer is required.

```sh
pnpm install
cp .env.example .env.local
pnpm dev
```

Set `OPENAI_API_KEY` and `OPENAI_MODEL` in `.env.local`, then open `http://localhost:3000`. Current game state is saved in browser `localStorage`; **New Game** clears it after confirmation.

For local UI testing without a paid model call, set `MAYHEM_RECOMMENDATION_PROVIDER=fake`. The fake always chooses the first valid candidate and is explicitly labeled as non-strategic.

Expand **Recommendation debug** below the page to inspect the normalized snapshot, the exact candidate-constrained request, provider/model label, and locally validated structured response. Provider credentials are server-only and are never included in this panel.

## Refresh the snapshot

Node.js 20.9 or newer is the only runtime requirement.

```sh
npm run data:refresh
```

If `npm` is unavailable, run the script directly:

```sh
node scripts/refresh-data.mjs
```

The command resolves the newest Riot Data Dragon version, derives and verifies the matching pinned CommunityDragon patch, validates all normalized records, and writes `data/generated/<data-dragon-patch>/`.

An explicit historical Data Dragon patch can be requested with `--patch`:

```sh
node scripts/refresh-data.mjs --patch 16.19.1
```

The application runtime should read the generated JSON only. It should never fetch these upstream sources during a game.

## Rerun the Volibear calibration

With the development server running and a real recommendation provider configured, run:

```sh
pnpm calibrate:volibear
```

This posts the preserved `Volibear / Courage of the Colossus / Dropkick / Clown College` state from `data/calibration/volibear-dropkick.json` to the local recommendation endpoint. It prints the validated recommendation and request-size measurements; it does not assert which augment must win. Set `MAYHEM_CALIBRATION_URL` to target a different local endpoint.
