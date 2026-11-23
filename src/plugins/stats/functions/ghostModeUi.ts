/**
 * Ghost Mode in Discord. There is no command of its own (the bot is near Discord's 100 command
 * limit): your own /profile card carries a "Ghost Mode" button, which opens these controls
 * privately. Anyone pressing that button on someone else's /profile gets their OWN controls, never
 * the card owner's. The allow list is managed on the website (linked from here).
 *
 * Ghost Mode only changes what other people see. Stats, XP, streaks, voice time and coins keep
 * being tracked as normal.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ButtonInteraction,
  type MessageActionRowComponentBuilder,
  type StringSelectMenuInteraction,
} from "discord.js";
import { APP_EMOJI } from "../../../core/appEmojis.js";
import { resultEdit, resultReply } from "../../../core/responses.js";
import { getSiteUrl } from "../../../core/docsUrl.js";
import { getGhostState, listGhostAllowlist, setGhostMode } from "../../../core/privacy/ghostMode.js";
import { GHOST_DURATION_LABELS, isGhostActive, isGhostDuration, type GhostDuration } from "../../../core/privacy/policy.js";

export const GHOST_PREFIX = "dl:ghost";
const OPEN_ID = `${GHOST_PREFIX}:open`;
const SET_ID = `${GHOST_PREFIX}:set`;
const OFF_ID = `${GHOST_PREFIX}:off`;

export const GHOST_TITLE = "Ghost Mode";

export function ghostSettingsUrl(): string {
  return `${getSiteUrl()}/account?tab=privacy#ghost-mode`;
}

/** The /profile button that opens the presser's own Ghost Mode controls. */
export function ghostModeButton(on: boolean): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(OPEN_ID)
    .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setEmoji(on ? APP_EMOJI.locked : APP_EMOJI.unlock)
    .setLabel(on ? "Ghost Mode: On" : "Ghost Mode");
}

/** What a global /rank (or other cross-server lookup) shows for someone in Ghost Mode. `{user}`
 *  is filled in by the translator. */
export const GHOST_NOTICE = {
  title: "Ghost Mode is on",
  body: "<@{user}> has chosen to keep their activity across servers private. Their rank in this server is still available with `/rank scope:Server`.",
} as const;

function statusLine(userId: string, now = new Date()): string {
  const state = getGhostState(userId);
  const allowed = listGhostAllowlist(userId).length;
  const allowedLine = allowed
    ? `${allowed === 1 ? "1 person" : `${allowed} people`} on your allow list still ${allowed === 1 ? "sees" : "see"} your live activity.`
    : "Nobody is on your allow list yet. You can add people on the website.";
  if (!isGhostActive(state, now)) {
    return [
      "**Off.** Other people see your activity across servers on your profile and rank as a daily snapshot taken at 00:00 UTC, never live.",
      "",
      "Turn Ghost Mode on to hide your global stats, the servers you're active in and your place on every leaderboard (global and in each server) from everyone else. Your stats are still tracked as normal, and you can still check your own rank.",
    ].join("\n");
  }
  const until = state.until ? `until <t:${Math.floor(state.until.getTime() / 1000)}:f> (<t:${Math.floor(state.until.getTime() / 1000)}:R>)` : "until you turn it off";
  return [
    `**On** ${until}.`,
    "",
    "Other people can't see your global stats, the servers you're active in or your place on any leaderboard (global or in a server). Your stats are still tracked as normal, and you can still check your own rank.",
    "",
    allowedLine,
  ].join("\n");
}

function controls(on: boolean): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const select = new StringSelectMenuBuilder()
    .setCustomId(SET_ID)
    .setPlaceholder(on ? "Extend or change how long" : "Turn on for...")
    .addOptions(
      (Object.keys(GHOST_DURATION_LABELS) as GhostDuration[]).map((value) =>
        new StringSelectMenuOptionBuilder().setValue(value).setLabel(GHOST_DURATION_LABELS[value]).setEmoji(value === "forever" ? APP_EMOJI.locked : APP_EMOJI.hourglass),
      ),
    );
  const buttons = new ActionRowBuilder<MessageActionRowComponentBuilder>();
  if (on) buttons.addComponents(new ButtonBuilder().setCustomId(OFF_ID).setStyle(ButtonStyle.Danger).setEmoji(APP_EMOJI.unlock).setLabel("Turn off"));
  buttons.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(ghostSettingsUrl()).setLabel("Manage who can see you"));
  return [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select), buttons];
}

const options = (client: ButtonInteraction["client"], on: boolean) => ({ client, emoji: on ? APP_EMOJI.locked : APP_EMOJI.unlock });

export function isGhostComponent(customId: string): boolean {
  return customId === OPEN_ID || customId === SET_ID || customId === OFF_ID;
}

export async function handleGhostButton(interaction: ButtonInteraction): Promise<boolean> {
  if (interaction.customId === OPEN_ID) {
    const on = isGhostActive(getGhostState(interaction.user.id));
    await interaction.reply(resultReply(GHOST_TITLE, statusLine(interaction.user.id), true, options(interaction.client, on), controls(on)));
    return true;
  }
  if (interaction.customId === OFF_ID) {
    setGhostMode(interaction.user.id, null);
    await interaction.update(resultEdit(GHOST_TITLE, statusLine(interaction.user.id), options(interaction.client, false), controls(false)));
    return true;
  }
  return false;
}

export async function handleGhostSelect(interaction: StringSelectMenuInteraction): Promise<boolean> {
  if (interaction.customId !== SET_ID) return false;
  const value = interaction.values[0];
  if (!isGhostDuration(value)) return true;
  setGhostMode(interaction.user.id, value);
  await interaction.update(resultEdit(GHOST_TITLE, statusLine(interaction.user.id), options(interaction.client, true), controls(true)));
  return true;
}
