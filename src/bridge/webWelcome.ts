import type { Client, Guild, GuildMember } from "discord.js";
import {
  zWelcomeCardConfig,
  zWelcomeEmbedConfig,
  zWelcomeMessageConfig,
} from "../config/schemas/welcome.js";
import {
  deleteWelcomeAsset,
  readWelcomeAsset,
  saveWelcomeBackgroundAsset,
} from "../plugins/welcome_message/functions/assets.js";
import { renderWelcomeCard } from "../plugins/welcome_message/functions/cardRenderer.js";
import {
  loadWelcomeConfig,
  sendWelcomeEvent,
} from "../plugins/welcome_message/functions/handlers.js";
import {
  previewEmbedJson,
  type WelcomeTarget,
} from "../plugins/welcome_message/functions/messageBuilder.js";

export async function uploadWelcomeBackground(
  guildId: string,
  base64: string,
): Promise<{ assetId: string; bytes: number }> {
  const cleaned = base64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
  const raw = Buffer.from(cleaned, "base64");
  return saveWelcomeBackgroundAsset(guildId, raw);
}

export function getWelcomeBackground(guildId: string, assetId: string): Buffer | null {
  return readWelcomeAsset(guildId, assetId);
}

export function removeWelcomeBackground(guildId: string, assetId: string): boolean {
  return deleteWelcomeAsset(guildId, assetId);
}

export type WelcomePreviewRequest = {
  card?: unknown;
  embed?: unknown;
  content?: string;
  sampleUserId?: string;
};

export async function buildWelcomePreview(
  client: Client,
  guild: Guild,
  body: WelcomePreviewRequest,
): Promise<{
  pngBase64: string | null;
  content: string;
  embed: Record<string, unknown> | null;
}> {
  const card = zWelcomeCardConfig.parse(body.card ?? {});
  const embed = zWelcomeEmbedConfig.parse(body.embed ?? {});

  let member = body.sampleUserId
    ? await guild.members.fetch(body.sampleUserId).catch(() => null)
    : null;
  if (!member) {
    member =
      guild.members.me ??
      (client.user ? await guild.members.fetch(client.user.id).catch(() => null) : null);
  }

  const ctx = {
    guildId: guild.id,
    member,
    user: member?.user ?? client.user,
    guild,
  };

  const { renderTemplate } = await import("../core/templates.js");
  const content = renderTemplate(typeof body.content === "string" ? body.content : "", {
    member,
    user: ctx.user,
    guild,
  });

  let pngBase64: string | null = null;
  if (card.enabled) {
    const png = await renderWelcomeCard(card, ctx);
    pngBase64 = png.toString("base64");
  }

  return {
    pngBase64,
    content,
    embed: previewEmbedJson(embed, ctx),
  };
}

export async function sendWelcomeTest(
  guild: Guild,
  member: GuildMember,
  target: WelcomeTarget,
  draftConfig?: unknown,
): Promise<{ ok: boolean; detail: string }> {
  const saved = await loadWelcomeConfig(guild.id);
  if (!saved && draftConfig == null) {
    return { ok: false, detail: "Welcomer plugin is disabled for this server." };
  }

  let config = saved;
  if (draftConfig != null) {
    try {
      config = zWelcomeMessageConfig.parse(draftConfig);
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "Invalid welcomer draft config.",
      };
    }
  }

  if (!config) {
    return { ok: false, detail: "Welcomer plugin is disabled for this server." };
  }

  return sendWelcomeEvent(target, member, config);
}
