/**
 * How a run talks back to the person who triggered it. An interaction must be answered within
 * three seconds, so runs defer first and fill the deferred reply with the first reply step;
 * later replies are follow-ups. After a long Wait (process may even have restarted) the stored
 * interaction token is used for follow-ups while it is still valid (15 minutes), then public
 * replies fall back to a normal channel message.
 */
import {
  MessageFlags,
  Routes,
  type Client,
  type InteractionReplyOptions,
  type Message,
  type ModalBuilder,
  type RepliableInteraction,
} from "discord.js";
import { resultReply } from "../../../core/responses.js";
import { guildResultOptions } from "../../../core/embeds.js";
import type { GuildConfig } from "../../../config/schemas/guild.js";
import { fetchGuildTextChannel } from "../../../core/guildChannel.js";

export type OutgoingMessage = {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  flags?: number;
  poll?: unknown;
  allowedMentions: { parse?: ("users" | "roles" | "everyone")[]; users?: string[]; roles?: string[] };
};

export interface Responder {
  /** Whether the interaction got any response yet (defer counts). */
  readonly acknowledged: boolean;
  /** Whether a modal can still be shown (nothing sent yet). */
  readonly canShowModal: boolean;
  defer(ephemeral: boolean): Promise<void>;
  send(message: OutgoingMessage, ephemeral: boolean): Promise<Message | null>;
  editFirst(message: OutgoingMessage): Promise<Message | null>;
  showModal(modal: ModalBuilder): Promise<void>;
  /** Shows a refusal or failure to the runner only. */
  fail(title: string, details: string): Promise<void>;
  /** Called at the end of a run: settles a deferred reply nobody filled. */
  finish(): Promise<void>;
  /** For saving with a Wait: token details to keep replying later. */
  token(): { applicationId: string; token: string; expiresAt: number } | null;
}

function withEphemeral(message: OutgoingMessage, ephemeral: boolean): InteractionReplyOptions {
  const flags = (message.flags ?? 0) | (ephemeral ? MessageFlags.Ephemeral : 0);
  return { ...(message as InteractionReplyOptions), flags: flags as InteractionReplyOptions["flags"] };
}

export class InteractionResponder implements Responder {
  private deferredEphemeral: boolean | null = null;
  private placeholderFilled = false;
  private readonly createdAt = Date.now();

  constructor(
    private readonly interaction: RepliableInteraction,
    private readonly client: Client,
    private readonly guildConfig: GuildConfig,
  ) {}

  get acknowledged(): boolean {
    return this.interaction.deferred || this.interaction.replied;
  }

  get canShowModal(): boolean {
    return !this.acknowledged && "showModal" in this.interaction;
  }

  async defer(ephemeral: boolean): Promise<void> {
    if (this.acknowledged) return;
    await this.interaction.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : undefined });
    this.deferredEphemeral = ephemeral;
  }

  async send(message: OutgoingMessage, ephemeral: boolean): Promise<Message | null> {
    if (!this.acknowledged) {
      const response = await this.interaction.reply({ ...withEphemeral(message, ephemeral), withResponse: true });
      return response.resource?.message ?? null;
    }
    if (this.deferredEphemeral !== null && !this.placeholderFilled && this.deferredEphemeral === ephemeral) {
      this.placeholderFilled = true;
      const { flags, ...rest } = withEphemeral(message, false);
      const v2 = typeof flags === "number" ? flags & MessageFlags.IsComponentsV2 : 0;
      return (await this.interaction.editReply({ ...(rest as object), ...(v2 ? { flags: v2 } : {}) })) as Message;
    }
    return (await this.interaction.followUp(withEphemeral(message, ephemeral))) as Message;
  }

  async editFirst(message: OutgoingMessage): Promise<Message | null> {
    const { flags, ...rest } = withEphemeral(message, false);
    const v2 = typeof flags === "number" ? flags & MessageFlags.IsComponentsV2 : 0;
    this.placeholderFilled = true;
    return (await this.interaction.editReply({ ...(rest as object), ...(v2 ? { flags: v2 } : {}) })) as Message;
  }

  async showModal(modal: ModalBuilder): Promise<void> {
    if (!("showModal" in this.interaction) || this.acknowledged) throw new Error("A form can only be shown before anything is sent.");
    await (this.interaction as unknown as { showModal(m: ModalBuilder): Promise<unknown> }).showModal(modal);
  }

  async fail(title: string, details: string): Promise<void> {
    const payload = resultReply(title, details, true, guildResultOptions(this.client, this.guildConfig, { tone: "error" }));
    try {
      if (!this.acknowledged) {
        await this.interaction.reply(payload);
        return;
      }
      if (this.deferredEphemeral === true && !this.placeholderFilled) {
        this.placeholderFilled = true;
        await this.interaction.editReply(payload as never);
        return;
      }
      if (this.deferredEphemeral === false && !this.placeholderFilled) {
        this.placeholderFilled = true;
        await this.interaction.deleteReply().catch(() => null);
      }
      await this.interaction.followUp(payload);
    } catch {
      /* the interaction may have expired */
    }
  }

  async finish(): Promise<void> {
    if (this.deferredEphemeral === null || this.placeholderFilled) return;
    this.placeholderFilled = true;
    try {
      if (this.deferredEphemeral) {
        await this.interaction.editReply(
          resultReply("Done", undefined, true, guildResultOptions(this.client, this.guildConfig, { tone: "success" })) as never,
        );
      } else {
        await this.interaction.deleteReply();
      }
    } catch {
      /* expired */
    }
  }

  token() {
    if (!this.acknowledged) return null;
    return { applicationId: this.interaction.applicationId, token: this.interaction.token, expiresAt: this.createdAt + 14 * 60_000 };
  }
}

/** Replies after a Wait: interaction follow-ups while the token lasts, then the channel. */
export class ResumedResponder implements Responder {
  readonly acknowledged = true;
  readonly canShowModal = false;

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly channelId: string,
    private readonly guildConfig: GuildConfig,
    private readonly saved: { applicationId: string; token: string; expiresAt: number } | null,
  ) {}

  private tokenValid(): boolean {
    return Boolean(this.saved && Date.now() < this.saved.expiresAt);
  }

  async defer(): Promise<void> {}

  async send(message: OutgoingMessage, ephemeral: boolean): Promise<Message | null> {
    if (this.tokenValid()) {
      const flags = (message.flags ?? 0) | (ephemeral ? MessageFlags.Ephemeral : 0);
      const body = { content: message.content, embeds: message.embeds, components: message.components, poll: message.poll, flags, allowed_mentions: message.allowedMentions };
      const raw = (await this.client.rest.post(Routes.webhook(this.saved!.applicationId, this.saved!.token), { body, query: new URLSearchParams({ wait: "true" }) })) as { id: string };
      return { id: raw.id, channelId: this.channelId } as unknown as Message;
    }
    if (ephemeral) throw new Error("The reply could no longer be sent privately (more than 15 minutes passed).");
    const channel = await fetchGuildTextChannel(this.client, this.guildId, this.channelId);
    if (!channel) throw new Error("The channel this command was used in is gone.");
    return channel.send(message as never);
  }

  async editFirst(message: OutgoingMessage): Promise<Message | null> {
    if (!this.tokenValid()) throw new Error("The reply can no longer be edited (more than 15 minutes passed).");
    const body = { content: message.content, embeds: message.embeds, components: message.components, allowed_mentions: message.allowedMentions };
    await this.client.rest.patch(Routes.webhookMessage(this.saved!.applicationId, this.saved!.token, "@original"), { body });
    return null;
  }

  async showModal(): Promise<void> {
    throw new Error("A form can't be shown after a wait.");
  }

  async fail(title: string, details: string): Promise<void> {
    if (!this.tokenValid()) return;
    const payload = resultReply(title, details, true, guildResultOptions(this.client, this.guildConfig, { tone: "error" }));
    await this.send(payload as unknown as OutgoingMessage, true).catch(() => null);
  }

  async finish(): Promise<void> {}

  token() {
    return this.saved;
  }
}
