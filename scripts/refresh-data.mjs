import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DRAGON_VERSIONS_URL = "https://ddragon.leagueoflegends.com/api/versions.json";
const COMMUNITY_DRAGON_ORIGIN = "https://raw.communitydragon.org";
const REQUEST_HEADERS = {
  accept: "application/json",
  "user-agent": "mayhem-lab-data-refresh/0.1 (local static data snapshot)",
};

function parseArgs(argv) {
  const args = { patch: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--patch") {
      args.patch = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (args.patch && !/^\d+\.\d+\.\d+$/.test(args.patch)) {
    throw new Error(`Invalid Data Dragon patch: ${args.patch}`);
  }
  return args;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
  return response.json();
}

function communityDragonPatchFor(dataDragonPatch) {
  const [major, minor] = dataDragonPatch.split(".");
  return `${major}.${minor}`;
}

function decodeEntities(value) {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

export function cleanRichText(value) {
  return decodeEntities(String(value ?? ""))
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/%i:[^%]+%/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
}

export function findUnresolvedTokens(value) {
  const text = String(value ?? "");
  const tokens = [
    ...text.matchAll(/@[A-Za-z0-9_.+*%\-/]+@/g),
    ...text.matchAll(/\{\{[^{}]+\}\}/g),
  ].map((match) => match[0]);
  return [...new Set(tokens)].sort();
}

function normalizedLookup(value) {
  return String(value ?? "").toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

function normalizeRarity(value, fallbackValue) {
  const source = String(value ?? fallbackValue ?? "").toLowerCase();
  if (source.includes("prismatic") || source === "2") return "prismatic";
  if (source.includes("gold") || source === "1") return "gold";
  if (source.includes("silver") || source === "0") return "silver";
  return "unknown";
}

function communityDragonAssetUrl(patch, assetPath) {
  if (!assetPath) return null;
  const relativePath = String(assetPath)
    .replace(/^\/lol-game-data\/assets\//i, "")
    .replace(/^assets\//i, "assets/")
    .toLowerCase();
  return `${COMMUNITY_DRAGON_ORIGIN}/${patch}/plugins/rcp-be-lol-game-data/global/default/${relativePath}`;
}

function lookupString(stringTable, key) {
  if (!key) return "";
  return stringTable[key] ?? stringTable[String(key).toLowerCase()] ?? "";
}

export function expandStringReferences(value, stringTable, maxDepth = 3) {
  let expanded = String(value ?? "");
  for (let depth = 0; depth < maxDepth; depth += 1) {
    let changed = false;
    expanded = expanded.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, key) => {
      const replacement = lookupString(stringTable, key.trim());
      if (!replacement) return match;
      changed = true;
      return replacement;
    });
    if (!changed) break;
  }
  return expanded;
}

function descriptionIssues(description) {
  const unresolvedTokens = findUnresolvedTokens(description);
  const issues = [];
  const semanticText = String(description ?? "")
    .replace(/@[A-Za-z0-9_.+*%\-/]+@/g, "")
    .replace(/\{\{[^{}]+\}\}/g, "")
    .replace(/[^a-z]+/gi, " ")
    .trim();
  if (!description || semanticText.split(/\s+/).filter(Boolean).length < 2) {
    issues.push("empty-or-unusable");
  }
  if (/\b(?:todo|placeholder|generatedtip_)\b/i.test(description)) issues.push("internal-placeholder-text");
  if (unresolvedTokens.length > 0) issues.push("unresolved-tokens");
  if (unresolvedTokens.length >= 3) issues.push("placeholder-heavy");
  return { unresolvedTokens, issues };
}

function formatResolvedNumber(value) {
  const rounded = Math.round(value * 1_000) / 1_000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

export function resolveDirectDescriptionTokens(description, spellData = {}) {
  const dataValues = new Map(
    (spellData.DataValues ?? []).map((entry) => [String(entry.name).toLowerCase(), entry]),
  );
  const resolvedTokens = [];
  const contextualTokens = [];

  let normalized = String(description ?? "").replace(
    /\{\{\s*SpellName\s*\}\}/gi,
    (token) => {
      contextualTokens.push(token);
      return "the affected ability";
    },
  );

  normalized = normalized.replace(
    /@([A-Za-z0-9_.]+)(?:\*([0-9.]+))?@/g,
    (token, rawName, rawMultiplier) => {
      if (rawName.toLowerCase() === "spellname") {
        contextualTokens.push(token);
        return "the affected ability";
      }

      const dataValue = dataValues.get(rawName.toLowerCase());
      const values = dataValue?.values ?? [];
      if (
        values.length === 0 ||
        !values.every(
          (value) => typeof value === "number" && Math.abs(value - values[0]) < 0.000001,
        )
      ) {
        return token;
      }

      const multiplier = rawMultiplier ? Number(rawMultiplier) : 1;
      const value = values[0] * multiplier;
      const renderedValue = formatResolvedNumber(value);
      resolvedTokens.push({
        token,
        renderedValue,
        dataValue: dataValue.name,
        source: "communitydragon-root-spell-data-value",
        multiplier,
      });
      return renderedValue;
    },
  );

  normalized = normalized
    .replace(/\b([Yy])our the affected ability\b/g, (_, first) => `${first}our affected ability`)
    .replace(/[ \t]+/g, " ")
    .trim();

  return {
    description: normalized,
    resolvedTokens,
    contextualTokens: [...new Set(contextualTokens)],
  };
}

function selectDescription(augment, stringTable) {
  const keys = [...new Set([augment.DescriptionTra, augment.AugmentTooltipTra].filter(Boolean))];
  const candidates = keys
    .map((key, index) => {
      const description = cleanRichText(expandStringReferences(lookupString(stringTable, key), stringTable));
      const quality = descriptionIssues(description);
      return {
        key,
        description,
        ...quality,
        score:
          (quality.issues.includes("empty-or-unusable") ? 10_000 : 0) +
          quality.unresolvedTokens.length * 100 +
          (quality.issues.includes("internal-placeholder-text") ? 50 : 0) +
          index,
      };
    })
    .filter((candidate) => candidate.description);

  if (candidates.length === 0) {
    return {
      key: augment.DescriptionTra ?? augment.AugmentTooltipTra ?? null,
      description: "",
      unresolvedTokens: [],
      issues: ["empty-or-unusable"],
    };
  }
  candidates.sort((left, right) => left.score - right.score);
  return candidates[0];
}

export function normalizeChampions(raw, patch) {
  return Object.values(raw.data ?? {})
    .map((champion) => {
      const [q, w, e, r] = champion.spells ?? [];
      const normalizeAbility = (ability) => ({
        name: cleanRichText(ability?.name),
        description: cleanRichText(ability?.description),
      });
      return {
        id: Number(champion.key),
        key: champion.id,
        name: champion.name,
        title: champion.title,
        tags: champion.tags ?? [],
        kit: {
          passive: normalizeAbility(champion.passive),
          q: normalizeAbility(q),
          w: normalizeAbility(w),
          e: normalizeAbility(e),
          r: normalizeAbility(r),
        },
        image: {
          file: champion.image?.full ?? null,
          url: champion.image?.full
            ? `https://ddragon.leagueoflegends.com/cdn/${patch}/img/champion/${champion.image.full}`
            : null,
        },
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeItems(raw, patch) {
  return Object.entries(raw.data ?? {})
    // Data Dragon occasionally ships internal placeholder rows with no display
    // name (and, in some cases, no enabled map). They cannot be looked up
    // reliably by the app, so they are deliberately excluded.
    .filter(([rawId, item]) => Number.isInteger(Number(rawId)) && Number(rawId) > 0 && item.name?.trim())
    .map(([rawId, item]) => ({
      id: Number(rawId),
      name: item.name,
      description: cleanRichText(item.description),
      plainText: item.plaintext ?? "",
      purchasable: Boolean(item.gold?.purchasable),
      gold: {
        base: Number(item.gold?.base ?? 0),
        total: Number(item.gold?.total ?? 0),
        sell: Number(item.gold?.sell ?? 0),
      },
      tags: item.tags ?? [],
      stats: item.stats ?? {},
      from: (item.from ?? []).map(Number),
      into: (item.into ?? []).map(Number),
      mapIds: Object.entries(item.maps ?? {})
        .filter(([, enabled]) => enabled)
        .map(([mapId]) => Number(mapId))
        .sort((left, right) => left - right),
      image: {
        file: item.image?.full ?? null,
        url: item.image?.full
          ? `https://ddragon.leagueoflegends.com/cdn/${patch}/img/item/${item.image.full}`
          : null,
      },
    }))
    .sort((left, right) => left.id - right.id);
}

export function normalizeAugments({ kiwiData, clientMetadata, stringTable, overrides, communityPatch, sourceUrl }) {
  const metadataById = new Map(clientMetadata.map((augment) => [Number(augment.id), augment]));
  const membership = Object.entries(kiwiData)
    .filter(([, value]) => value?.__type === "AugmentData")
    .map(([sourcePath, value]) => ({ sourcePath, ...value }));

  const joined = membership.map((augment) => {
    const id = Number(augment.AugmentPlatformId);
    const metadata = metadataById.get(id);
    if (!metadata) {
      return { id, internalName: augment.AugmentNameId, joinError: true };
    }

    const selected = selectDescription(augment, stringTable);
    const override = overrides[augment.AugmentNameId] ?? overrides[String(id)] ?? null;
    const rootSpell = kiwiData[augment.RootSpell]?.mSpell ?? {};
    const normalizedDescription = override
      ? {
          description: cleanRichText(override.description),
          resolvedTokens: [],
          contextualTokens: [],
        }
      : resolveDirectDescriptionTokens(selected.description, rootSpell);
    const description = normalizedDescription.description;
    const quality = descriptionIssues(description);
    const requiresAbilityContext =
      Boolean(override?.requiresAbilityContext) || normalizedDescription.contextualTokens.length > 0;
    const descriptionQuality = quality.issues.includes("empty-or-unusable")
      ? "unusable"
      : quality.unresolvedTokens.length > 0
        ? "usable-with-missing-detail"
        : requiresAbilityContext
          ? "contextual-usable"
          : "ai-usable";
    const localizedName = cleanRichText(lookupString(stringTable, augment.NameTra));

    return {
      id,
      internalName: augment.AugmentNameId,
      name: localizedName || metadata.nameTRA,
      rarity: normalizeRarity(metadata.rarity, augment.rarity),
      description,
      descriptionStatus: override
        ? "curated-override"
        : quality.unresolvedTokens.length > 0
            ? "unresolved-tokens"
            : requiresAbilityContext
              ? "contextual-normalized"
              : "clean",
      descriptionQuality,
      requiresAbilityContext,
      contextualTokens: normalizedDescription.contextualTokens,
      resolvedTokens: normalizedDescription.resolvedTokens.map((resolution) => ({
        ...resolution,
        sourcePath: augment.RootSpell,
      })),
      unresolvedTokens: quality.unresolvedTokens,
      descriptionSource: override
        ? {
            type: "curated-override",
            key: augment.AugmentNameId,
            reason: override.reason,
          }
        : {
            type: "communitydragon-string",
            key: selected.key,
            url: sourceUrl,
          },
      icon: communityDragonAssetUrl(communityPatch, metadata.augmentSmallIconPath),
      sourcePath: augment.sourcePath,
    };
  });

  return joined.sort((left, right) => left.name.localeCompare(right.name));
}

function duplicateValues(records, selector, normalize = (value) => value) {
  const seen = new Map();
  for (const record of records) {
    const key = normalize(selector(record));
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(record);
  }
  return [...seen.entries()]
    .filter(([, matches]) => matches.length > 1)
    .map(([value, matches]) => ({ value, ids: matches.map((record) => record.id) }));
}

export function validateSnapshot({ champions, items, augments, overrideKeys = [] }) {
  const errors = [];
  const warnings = [];
  const augmentJoinFailures = augments.filter((augment) => augment.joinError);
  const duplicateAugmentIds = duplicateValues(augments, (augment) => augment.id);
  const duplicateAugmentInternalNames = duplicateValues(augments, (augment) => augment.internalName);
  const duplicateAugmentNames = duplicateValues(augments, (augment) => augment.name, normalizedLookup);
  const invalidChampions = champions.filter(
    (champion) =>
      !Number.isInteger(champion.id) ||
      champion.id <= 0 ||
      !champion.name?.trim() ||
      !champion.key?.trim() ||
      !["passive", "q", "w", "e", "r"].every(
        (slot) => champion.kit?.[slot]?.name?.trim() && champion.kit?.[slot]?.description?.trim(),
      ),
  );
  const duplicateChampionIds = duplicateValues(champions, (champion) => champion.id);
  const duplicateChampionNames = duplicateValues(champions, (champion) => champion.name, normalizedLookup);
  const invalidItems = items.filter((item) => !Number.isInteger(item.id) || item.id <= 0 || !item.name?.trim());
  const duplicateItemIds = duplicateValues(items, (item) => item.id);
  const knownOverrideKeys = new Set(augments.flatMap((augment) => [augment.internalName, String(augment.id)]));
  const unknownOverrideKeys = overrideKeys.filter((key) => !knownOverrideKeys.has(key));
  const descriptionProblems = augments
    .filter(
      (augment) => augment.unresolvedTokens?.length > 0 || augment.descriptionQuality === "unusable",
    )
    .map((augment) => ({
      id: augment.id,
      internalName: augment.internalName,
      name: augment.name,
      status: augment.descriptionStatus,
      quality: augment.descriptionQuality,
      requiresAbilityContext: augment.requiresAbilityContext,
      unresolvedTokens: augment.unresolvedTokens ?? [],
    }));
  const placeholderHeavyDescriptions = descriptionProblems.filter(
    (problem) => problem.unresolvedTokens.length >= 3,
  );
  const contextualDescriptions = augments.filter(
    (augment) => augment.descriptionQuality === "contextual-usable",
  );
  const usableWithMissingDetail = augments.filter(
    (augment) => augment.descriptionQuality === "usable-with-missing-detail",
  );
  const unusableDescriptions = augments.filter(
    (augment) => augment.descriptionQuality === "unusable",
  );
  const cleanAiUsableDescriptions = augments.filter(
    (augment) => augment.descriptionQuality === "ai-usable",
  );
  const curatedFallbackDescriptions = augments.filter(
    (augment) => augment.descriptionStatus === "curated-override",
  );
  const resolvedTokenCount = augments.reduce(
    (total, augment) => total + (augment.resolvedTokens?.length ?? 0),
    0,
  );
  const remainingUnresolvedTokenCount = augments.reduce(
    (total, augment) => total + (augment.unresolvedTokens?.length ?? 0),
    0,
  );

  if (augmentJoinFailures.length) errors.push(`${augmentJoinFailures.length} KIWI augments did not join to client metadata.`);
  if (duplicateAugmentIds.length) errors.push("Augment IDs are not unique.");
  if (duplicateAugmentInternalNames.length) errors.push("Augment internal names are not unique.");
  if (duplicateAugmentNames.length) errors.push("Normalized augment display names are not unique.");
  if (invalidChampions.length) errors.push(`${invalidChampions.length} champions have invalid IDs, names, or kit entries.`);
  if (duplicateChampionIds.length || duplicateChampionNames.length) errors.push("Champion IDs or names are not unique.");
  if (invalidItems.length) errors.push(`${invalidItems.length} items have invalid IDs or names.`);
  if (duplicateItemIds.length) errors.push("Item IDs are not unique.");
  if (unknownOverrideKeys.length) errors.push(`Unknown curated override keys: ${unknownOverrideKeys.join(", ")}.`);
  if (usableWithMissingDetail.length) {
    warnings.push(
      `${usableWithMissingDetail.length} AI-usable augment descriptions retain unresolved numerical or detail tokens.`,
    );
  }
  if (unusableDescriptions.length) {
    errors.push(`${unusableDescriptions.length} augment descriptions are not AI-usable.`);
  }

  return {
    valid: errors.length === 0,
    status: errors.length ? "failed" : warnings.length ? "passed-with-warnings" : "passed",
    summary: {
      errorCount: errors.length,
      warningCount: warnings.length,
      unresolvedDescriptionCount: descriptionProblems.length,
      placeholderHeavyDescriptionCount: placeholderHeavyDescriptions.length,
      cleanAiUsableDescriptionCount: cleanAiUsableDescriptions.length,
      contextualUsableDescriptionCount: contextualDescriptions.length,
      usableWithMissingDetailCount: usableWithMissingDetail.length,
      unusableDescriptionCount: unusableDescriptions.length,
      curatedFallbackDescriptionCount: curatedFallbackDescriptions.length,
      resolvedTokenCount,
      remainingUnresolvedTokenCount,
    },
    checks: {
      everyKiwiAugmentResolved: augmentJoinFailures.length === 0,
      augmentIdsUnique: duplicateAugmentIds.length === 0,
      augmentInternalNamesUnique: duplicateAugmentInternalNames.length === 0,
      augmentDisplayNamesUnique: duplicateAugmentNames.length === 0,
      championIdsNamesAndKitsValid: invalidChampions.length === 0,
      championIdsAndNamesUnique: duplicateChampionIds.length === 0 && duplicateChampionNames.length === 0,
      itemIdsAndNamesValid: invalidItems.length === 0,
      itemIdsUnique: duplicateItemIds.length === 0,
      curatedOverridesResolve: unknownOverrideKeys.length === 0,
      descriptionProblemsSurfaced: true,
      allDescriptionsAiUsable: unusableDescriptions.length === 0,
    },
    errors,
    warnings,
    descriptionProblems,
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const { patch: requestedPatch } = parseArgs(process.argv.slice(2));
  console.log("Resolving Riot Data Dragon patch...");
  const versions = await fetchJson(DATA_DRAGON_VERSIONS_URL);
  const dataDragonPatch = requestedPatch ?? versions[0];
  if (!versions.includes(dataDragonPatch)) {
    throw new Error(`Data Dragon patch ${dataDragonPatch} is not listed by Riot.`);
  }

  const communityPatch = communityDragonPatchFor(dataDragonPatch);
  const dataDragonBase = `https://ddragon.leagueoflegends.com/cdn/${dataDragonPatch}/data/en_US`;
  const communityBase = `${COMMUNITY_DRAGON_ORIGIN}/${communityPatch}`;
  const urls = {
    dataDragonVersions: DATA_DRAGON_VERSIONS_URL,
    champions: `${dataDragonBase}/championFull.json`,
    items: `${dataDragonBase}/item.json`,
    kiwiMembership: `${communityBase}/game/maps/modespecificdata/kiwi.bin.json`,
    augmentMetadata: `${communityBase}/plugins/rcp-be-lol-game-data/global/default/v1/cherry-augments.json`,
    mayhemStrings: `${communityBase}/game/en_us/data/menu/en_us/lol.stringtable.json`,
  };

  console.log(`Fetching Data Dragon ${dataDragonPatch} and pinned CommunityDragon ${communityPatch}...`);
  const [championRaw, itemRaw, kiwiData, clientMetadata, stringTableRaw, overrideFile] = await Promise.all([
    fetchJson(urls.champions),
    fetchJson(urls.items),
    fetchJson(urls.kiwiMembership),
    fetchJson(urls.augmentMetadata),
    fetchJson(urls.mayhemStrings),
    readFile(path.join(ROOT, "data", "curated", "augment-overrides.json"), "utf8").then(JSON.parse),
  ]);

  const champions = normalizeChampions(championRaw, dataDragonPatch);
  const items = normalizeItems(itemRaw, dataDragonPatch);
  const augments = normalizeAugments({
    kiwiData,
    clientMetadata,
    stringTable: stringTableRaw.entries ?? {},
    overrides: overrideFile.overrides ?? {},
    communityPatch,
    sourceUrl: urls.mayhemStrings,
  });
  const validation = validateSnapshot({
    champions,
    items,
    augments,
    overrideKeys: Object.keys(overrideFile.overrides ?? {}),
  });
  if (!validation.valid) {
    throw new Error(`Snapshot validation failed:\n- ${validation.errors.join("\n- ")}`);
  }

  const generatedAt = new Date().toISOString();
  const outputDirectory = path.join(ROOT, "data", "generated", dataDragonPatch);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeJson(path.join(outputDirectory, "champions.json"), {
      schemaVersion: 2,
      patch: dataDragonPatch,
      champions,
    }),
    writeJson(path.join(outputDirectory, "items.json"), {
      schemaVersion: 1,
      patch: dataDragonPatch,
      items,
    }),
    writeJson(path.join(outputDirectory, "augments.json"), {
      schemaVersion: 1,
      patch: dataDragonPatch,
      communityDragonPatch: communityPatch,
      gameMode: "KIWI",
      augments,
    }),
  ]);

  const manifest = {
    schemaVersion: 1,
    riotDataDragonPatch: dataDragonPatch,
    communityDragon: {
      patch: communityPatch,
      source: `${COMMUNITY_DRAGON_ORIGIN}/${communityPatch}/`,
      runtimeUsesLatest: false,
    },
    generatedAt,
    sources: urls,
    counts: {
      champions: champions.length,
      items: items.length,
      augments: augments.length,
      curatedAugmentOverrides: Object.keys(overrideFile.overrides ?? {}).length,
    },
    validation,
  };
  await writeJson(path.join(outputDirectory, "manifest.json"), manifest);

  console.log(`Wrote ${path.relative(ROOT, outputDirectory)}`);
  console.log(`Champions: ${champions.length}; items: ${items.length}; KIWI augments: ${augments.length}`);
  console.log(
    `Validation: ${validation.status}; unresolved descriptions: ${validation.summary.unresolvedDescriptionCount}; ` +
      `placeholder-heavy: ${validation.summary.placeholderHeavyDescriptionCount}`,
  );
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
