import type { Client, Guild, GuildMember, Message } from "discord.js";

import { configManager } from "../../../config/manager.js";

import { baseEmbed, setEmbedAuthor } from "../../../core/embeds.js";

import { pluginEnabled } from "../../../core/pluginCommand.js";

import { getCountersByType, updateCounterValue, type CounterRow } from "./store.js";



function counterLabel(type: string): string {

  if (type === "members") return "Members";

  if (type === "messages") return "Messages";

  return "Count";

}



function buildCounterEmbed(name: string, value: number, counterType: string, client: Client) {

  const label = counterLabel(counterType);

  return setEmbedAuthor(baseEmbed(), name, client, { tone: "neutral" })

    .setDescription(`**${value.toLocaleString()}** ${label.toLowerCase()}`)

    .setFooter({

      text: counterType === "custom" ? "Custom counter" : "Updates automatically",

    })

    .toJSON();

}



export function formatCounterMessage(name: string, value: number, counterType: string, client: Client) {

  return { embeds: [buildCounterEmbed(name, value, counterType, client)] };

}



export async function refreshCounterDisplay(guild: Guild, counter: CounterRow, value: number): Promise<void> {

  if (!counter.messageId) return;



  const channel = await guild.channels.fetch(counter.channelId).catch(() => null);

  if (!channel?.isTextBased()) return;



  const message = await channel.messages.fetch(counter.messageId).catch(() => null);

  if (!message) return;



  await message.edit(formatCounterMessage(counter.name, value, counter.counterType, guild.client)).catch(() => null);

}



export async function syncCounterValue(guild: Guild, counter: CounterRow, value: number): Promise<void> {

  await updateCounterValue(guild.id, counter.name, value);

  await refreshCounterDisplay(guild, { ...counter, value }, value);

}



export async function handleCounterMemberChange(member: GuildMember): Promise<void> {

  if (!member.guild || member.user.bot) return;



  const guildConfig = await configManager.getEffectiveConfig(member.guild.id);

  if (!pluginEnabled(guildConfig, "counters")) return;



  const memberCounters = await getCountersByType(member.guild.id, "members");

  if (memberCounters.length === 0) return;



  await member.guild.members.fetch().catch(() => null);

  const count = member.guild.memberCount;



  for (const counter of memberCounters) {

    await syncCounterValue(member.guild, counter, count);

  }

}



export async function handleCounterMessage(message: Message): Promise<void> {

  if (!message.guild || message.author.bot) return;



  const guildConfig = await configManager.getEffectiveConfig(message.guild.id);

  if (!pluginEnabled(guildConfig, "counters")) return;



  const messageCounters = await getCountersByType(message.guild.id, "messages");

  for (const counter of messageCounters) {

    const next = counter.value + 1;

    await syncCounterValue(message.guild, counter, next);

  }

}


