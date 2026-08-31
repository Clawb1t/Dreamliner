import { listPlaneTypes, type CardType } from "../plugins/planes/functions/catalog.js";

/**
 * Public, not-per-user card catalog data — used by the website's marketing pages (e.g. the
 * homepage's decorative card stack), as opposed to userPublicProfile.ts's per-user inventory.
 */
export type PlaneCardCatalogEntry = {
  key: string;
  name: string;
  cardType: CardType;
  rarity: string;
  subtitle: string;
  imageKey: string;
};

export function listPublicPlaneCardCatalog(opts: { limit?: number } = {}): PlaneCardCatalogEntry[] {
  const rows = listPlaneTypes({ enabledOnly: true }).filter((r) => r.imageKey);
  const limited = opts.limit ? rows.slice(0, opts.limit) : rows;
  return limited.map((r) => ({
    key: r.key,
    name: r.name,
    cardType: r.cardType as CardType,
    rarity: r.rarity,
    subtitle: r.subtitle,
    imageKey: r.imageKey,
  }));
}
