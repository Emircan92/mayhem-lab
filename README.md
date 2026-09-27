# Mayhem Lab

Mayhem Lab is a local-first ARAM Mayhem game-state composer. Cut 2 adds a fast manual entry page over the versioned champion, item, and `KIWI` augment snapshot.

## Run the app

Node.js 20.9 or newer is required.

```sh
pnpm install
pnpm dev
```

Open `http://localhost:3000`. Current game state is saved in browser `localStorage`; **New Game** clears it after confirmation.

The two recommendation actions are intentionally non-functional until the recommendation cut. Expand **Recommendation snapshot** below the page to inspect the exact normalized JSON, deterministic facts, and warnings prepared for that future layer.

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
