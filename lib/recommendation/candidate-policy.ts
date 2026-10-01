import type { Item } from "../catalog";
import { normalizeCatalogItem } from "../preprocess-game-state";
import type { NormalizedItem } from "../recommendation-contract";

const ARAM_MAP_ID = 12;
const NON_ITEM_TAGS = new Set(["Consumable", "Trinket"]);
const OBVIOUS_INTERNAL_NAME = /(?:placeholder|dummy|do not use|internal only|test item)/i;

export type ItemCandidateExclusion =
  | "unnamed-or-internal"
  | "not-purchasable"
  | "not-available-on-aram"
  | "component"
  | "starter"
  | "non-item-category"
  | "no-positive-price";

export function itemCandidateExclusion(item: Item): ItemCandidateExclusion | null {
  if (!item.name.trim() || OBVIOUS_INTERNAL_NAME.test(item.name)) return "unnamed-or-internal";
  if (!item.purchasable) return "not-purchasable";
  if (!item.mapIds.includes(ARAM_MAP_ID)) return "not-available-on-aram";
  if (item.into.length > 0) return "component";
  if (item.tags.includes("Lane") && item.from.length === 0) return "starter";
  if (item.tags.some((tag) => NON_ITEM_TAGS.has(tag))) return "non-item-category";
  if (item.gold.total <= 0) return "no-positive-price";
  return null;
}

export function buildCompletedItemCandidates(items: Item[]): NormalizedItem[] {
  return items
    .filter((item) => itemCandidateExclusion(item) === null)
    .map(normalizeCatalogItem)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
}

