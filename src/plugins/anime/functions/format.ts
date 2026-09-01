/** Position indicator for a saved neko, e.g. "-# Saved neko 2/5". Nothing else goes in message
 *  content — the artist credit and the Nekos.best link are both buttons now, see buttons.ts. */
export function formatSavedNekoFooter(index: number, total: number): string {
  return `-# Saved neko ${index + 1}/${total}`;
}
