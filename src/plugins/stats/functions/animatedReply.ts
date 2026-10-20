import { AttachmentBuilder } from "discord.js";
import { getLogger } from "../../../core/logger.js";

/**
 * Still first, GIF second: a card whose background is animated is sent as its PNG straight away
 * (so the reply is as quick as ever), then the same reply is edited to swap the attachment for the
 * GIF once it has rendered. If the GIF fails or times out, the still simply stays.
 */

const log = getLogger("stats");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Edit = (options: any) => Promise<unknown>;

export type AnimatedCard = { buffer: Buffer; animate?: () => Promise<Buffer | null> };

/** Edits the reply to the GIF version (`name`.gif, replacing every attachment). True if it did. */
export async function upgradeToGif(
  edit: Edit,
  animate: (() => Promise<Buffer | null>) | undefined,
  name: string,
  payload: Record<string, unknown>,
  isCurrent?: () => boolean,
): Promise<boolean> {
  if (!animate) return false;
  const gif = await animate().catch(() => null);
  // The reply may have moved on (another page of /stats) while the GIF rendered.
  if (!gif || (isCurrent && !isCurrent())) return false;
  try {
    await edit({ ...payload, files: [new AttachmentBuilder(gif, { name: `${name}.gif` })], attachments: [] });
    return true;
  } catch (error) {
    log.warn(`[animated card] couldn't swap in the ${name} GIF (${gif.length} bytes), keeping the still:`, error);
    return false;
  }
}

/**
 * Sends `card` as `name`.png with `payload` (throws if that fails), then swaps in the GIF when the
 * card is animated. Resolves once both are done.
 */
export async function replyWithCard(
  edit: Edit,
  card: AnimatedCard,
  name: string,
  payload: Record<string, unknown>,
  onStillSent?: () => void,
): Promise<"still" | "gif"> {
  await edit({ ...payload, files: [new AttachmentBuilder(card.buffer, { name: `${name}.png` })] });
  onStillSent?.();
  return (await upgradeToGif(edit, card.animate, name, payload)) ? "gif" : "still";
}

/** Latest render per message, so a slow GIF never overwrites a newer view of the same message. */
const latest = new Map<string, number>();
let sequence = 0;

/** Marks a new view of `messageId`; the returned check is true while it is still the newest. */
export function claimMessageView(messageId: string): () => boolean {
  const mine = ++sequence;
  latest.set(messageId, mine);
  if (latest.size > 2000) latest.delete(latest.keys().next().value!);
  return () => latest.get(messageId) === mine;
}
