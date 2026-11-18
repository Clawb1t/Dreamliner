/** Filter vocabularies for the Discover catalogue (genre and platform chips on the site). */

export const CATALOG_GENRES = {
  shooter: "Shooter",
  moba: "MOBA",
  mmo: "MMO",
  rpg: "RPG",
  action: "Action",
  survival: "Survival",
  sandbox: "Sandbox",
  strategy: "Strategy",
  simulation: "Simulation",
  sports: "Sports",
  racing: "Racing",
  fighting: "Fighting",
  horror: "Horror",
  coop: "Co-op",
  party: "Party",
  card: "Card and deckbuilder",
  indie: "Indie",
} as const;
export type CatalogGenre = keyof typeof CATALOG_GENRES;

export const CATALOG_PLATFORMS = {
  pc: "PC",
  playstation: "PlayStation",
  xbox: "Xbox",
  switch: "Nintendo Switch",
  mobile: "Mobile",
} as const;
export type CatalogPlatform = keyof typeof CATALOG_PLATFORMS;

export function isCatalogGenre(value: string): value is CatalogGenre {
  return Object.hasOwn(CATALOG_GENRES, value);
}

export function isCatalogPlatform(value: string): value is CatalogPlatform {
  return Object.hasOwn(CATALOG_PLATFORMS, value);
}
