# Mayhem Lab

Cut 1 provides a versioned, local data snapshot for champions, items, and standard ARAM Mayhem (`KIWI`) augments.

## Refresh the snapshot

Node.js 20 or newer is the only requirement.

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
