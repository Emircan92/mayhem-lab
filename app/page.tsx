import augmentsSnapshot from "@/data/generated/16.19.1/augments.json";
import championsSnapshot from "@/data/generated/16.19.1/champions.json";
import itemsSnapshot from "@/data/generated/16.19.1/items.json";
import manifest from "@/data/generated/16.19.1/manifest.json";
import { GameStateComposer } from "@/components/GameStateComposer";
import type { Augment, Champion, Item } from "@/lib/catalog";

export default function Home() {
  return (
    <GameStateComposer
      augments={augmentsSnapshot.augments as Augment[]}
      champions={championsSnapshot.champions as Champion[]}
      items={itemsSnapshot.items as Item[]}
      patch={manifest.riotDataDragonPatch}
      generatedAt={manifest.generatedAt}
    />
  );
}
