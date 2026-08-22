import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { deferReplyOptions, resultEdit, resultReply, slashResultOptions } from "../../core/responses.js";
import { zEconomyConfig, type EconomyConfig } from "../../config/schemas/economy.js";
import { emitLog } from "../../core/logging/send.js";
import type { LogEmojiCategory } from "../../core/logging/emojis.js";
import { discordTimestamp, formatDuration } from "../../core/datetime.js";
import { shortEconomyError, formatBalances, formatCurrency, parseAutocompleteId } from "./functions/format.js";
import { EconomyError } from "./functions/money.js";
import * as money from "./functions/money.js";
import * as inventory from "./functions/inventory.js";
import * as rewards from "./functions/rewards.js";
import * as jobs from "./functions/jobs.js";
import * as pets from "./functions/pets.js";
import * as crafting from "./functions/crafting.js";
import * as quests from "./functions/quests.js";
import * as markets from "./functions/markets.js";
import * as seasons from "./functions/seasons.js";

type EconomyEventType =
  | "economy_adjust"
  | "economy_transfer"
  | "economy_shop"
  | "economy_trade"
  | "economy_auction"
  | "economy_freeze"
  | "economy_season";

const ECONOMY_EVENT_EMOJI: Record<EconomyEventType, LogEmojiCategory> = {
  economy_adjust: "action",
  economy_transfer: "action",
  economy_shop: "action",
  economy_trade: "action",
  economy_auction: "action",
  // Freeze restricts a member's economy access — treat it like a moderate moderation action.
  economy_freeze: "modModerate",
  economy_season: "serverUpdate",
};

async function logEconomy(
  ctx: {
    client: import("discord.js").Client;
    guildConfig: import("../../config/schemas/guild.js").GuildConfig;
  },
  eventType: EconomyEventType,
  title: string,
  information: string[],
  meta: { guildId: string; actorId?: string; targetId?: string; summary?: string },
) {
  await emitLog(
    ctx.client,
    ctx.guildConfig,
    { title, information, emojiCategory: ECONOMY_EVENT_EMOJI[eventType] },
    {
      guildId: meta.guildId,
      eventType,
      actorId: meta.actorId,
      targetId: meta.targetId,
      summary: meta.summary ?? title,
    },
  ).catch(() => null);
}

type Auth = { member: import("discord.js").GuildMember; pluginConfig: Record<string, unknown> };

async function auth(
  ctx: { interaction: ChatInputCommandInteraction; ephemeral: boolean; client: import("discord.js").Client; guildConfig: import("../../config/schemas/guild.js").GuildConfig },
  permission: string,
): Promise<{ auth: Auth; config: EconomyConfig; guildId: string; userId: string } | null> {
  const result = await requirePluginPermission(ctx as never, "economy", permission);
  if (!result) return null;
  const config = zEconomyConfig.parse(result.pluginConfig);
  const guildId = ctx.interaction.guildId!;
  money.ensureGuildCurrencies(guildId, config);
  inventory.seedDefaultCatalog(guildId);
  quests.seedDefaultQuests(guildId);
  jobs.seedDefaultJobs(guildId);
  pets.seedDefaultSpecies(guildId);
  money.grantStartingBalance(guildId, ctx.interaction.user.id, config);
  return { auth: result, config, guildId, userId: ctx.interaction.user.id };
}

async function replyErr(
  interaction: ChatInputCommandInteraction,
  ctx: import("../../core/types.js").SlashCommandContext,
  err: unknown,
  deferred: boolean,
  config?: EconomyConfig,
) {
  const msg = shortEconomyError(err, config);
  const payload = resultEdit("Economy", msg, slashResultOptions(ctx, { tone: "error" }));
  if (deferred) await interaction.editReply(payload);
  else await interaction.reply(resultReply("Economy", msg, ctx.ephemeral, slashResultOptions(ctx, { tone: "error" })));
}

function currencyOption(
  opt: import("discord.js").SlashCommandStringOption,
): import("discord.js").SlashCommandStringOption {
  return opt
    .setName("currency")
    .setDescription("Currency key (coins or gems)")
    .setRequired(false)
    .setAutocomplete(true);
}

function idAutocompleteOption(
  name: string,
  description: string,
): (opt: import("discord.js").SlashCommandStringOption) => import("discord.js").SlashCommandStringOption {
  return (opt) => opt.setName(name).setDescription(description).setRequired(true).setAutocomplete(true);
}

export const economyCommands: SlashCommandDefinition[] = [
  {
    plugin: "economy",
    data: new SlashCommandBuilder()
      .setName("economy")
      .setDescription("Server economy: balances, rewards, shops, pets, markets, and more")
      .addSubcommandGroup((g) =>
        g
          .setName("account")
          .setDescription("Balances, bank, history, and profile")
          .addSubcommand((s) =>
            s
              .setName("balance")
              .setDescription("View your balance")
              .addUserOption((o) => o.setName("user").setDescription("Member to view"))
              .addStringOption(currencyOption),
          )
          .addSubcommand((s) =>
            s
              .setName("bank")
              .setDescription("View bank balances")
              .addStringOption(currencyOption),
          )
          .addSubcommand((s) =>
            s
              .setName("deposit")
              .setDescription("Deposit into your bank")
              .addIntegerOption((o) => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1))
              .addStringOption(currencyOption),
          )
          .addSubcommand((s) =>
            s
              .setName("withdraw")
              .setDescription("Withdraw from your bank")
              .addIntegerOption((o) => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1))
              .addStringOption(currencyOption),
          )
          .addSubcommand((s) =>
            s
              .setName("history")
              .setDescription("Recent transactions")
              .addIntegerOption((o) => o.setName("limit").setDescription("Entries (max 25)").setMinValue(1).setMaxValue(25)),
          )
          .addSubcommand((s) =>
            s
              .setName("profile")
              .setDescription("Economy profile")
              .addUserOption((o) => o.setName("user").setDescription("Member to view")),
          )
          .addSubcommand((s) =>
            s
              .setName("privacy")
              .setDescription("Toggle balance privacy")
              .addBooleanOption((o) => o.setName("hide").setDescription("Hide balances from others").setRequired(true)),
          ),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("rewards")
          .setDescription("Claims and work")
          .addSubcommand((s) => s.setName("daily").setDescription("Claim daily reward"))
          .addSubcommand((s) => s.setName("weekly").setDescription("Claim weekly reward"))
          .addSubcommand((s) => s.setName("monthly").setDescription("Claim monthly reward"))
          .addSubcommand((s) => s.setName("streak").setDescription("View streak status"))
          .addSubcommand((s) => s.setName("work").setDescription("Do a quick work shift"))
          .addSubcommand((s) => s.setName("status").setDescription("Reward claim status")),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("social")
          .setDescription("Pay, gift, and inspect")
          .addSubcommand((s) =>
            s
              .setName("pay")
              .setDescription("Pay another member")
              .addUserOption((o) => o.setName("user").setDescription("Recipient").setRequired(true))
              .addIntegerOption((o) => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1))
              .addStringOption(currencyOption),
          )
          .addSubcommand((s) =>
            s
              .setName("gift")
              .setDescription("Gift an inventory item")
              .addUserOption((o) => o.setName("user").setDescription("Recipient").setRequired(true))
              .addStringOption((o) => o.setName("item").setDescription("Item key").setRequired(true).setAutocomplete(true))
              .addIntegerOption((o) => o.setName("quantity").setDescription("Quantity").setMinValue(1)),
          )
          .addSubcommand((s) =>
            s
              .setName("inspect")
              .setDescription("Inspect a member's public economy info")
              .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true)),
          ),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("shop")
          .setDescription("Shops and inventory")
          .addSubcommand((s) =>
            s
              .setName("browse")
              .setDescription("Browse shops")
              .addStringOption((o) => o.setName("shop").setDescription("Shop key").setAutocomplete(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("item")
              .setDescription("View an item")
              .addStringOption((o) => o.setName("item").setDescription("Item key").setRequired(true).setAutocomplete(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("buy")
              .setDescription("Buy from a listing")
              .addStringOption(idAutocompleteOption("listing", "Shop listing"))
              .addIntegerOption((o) => o.setName("quantity").setDescription("Quantity").setMinValue(1)),
          )
          .addSubcommand((s) =>
            s
              .setName("sell")
              .setDescription("Sell an item")
              .addStringOption((o) => o.setName("item").setDescription("Item key").setRequired(true).setAutocomplete(true))
              .addIntegerOption((o) => o.setName("quantity").setDescription("Quantity").setMinValue(1)),
          )
          .addSubcommand((s) =>
            s
              .setName("use")
              .setDescription("Use a consumable")
              .addStringOption((o) => o.setName("item").setDescription("Item key").setRequired(true).setAutocomplete(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("equip")
              .setDescription("Equip an item")
              .addStringOption((o) => o.setName("item").setDescription("Item key").setRequired(true).setAutocomplete(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("unequip")
              .setDescription("Unequip an item")
              .addStringOption((o) => o.setName("item").setDescription("Item key").setRequired(true).setAutocomplete(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("inventory")
              .setDescription("View your inventory")
              .addUserOption((o) => o.setName("user").setDescription("Member")),
          ),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("jobs")
          .setDescription("Careers")
          .addSubcommand((s) => s.setName("list").setDescription("List jobs"))
          .addSubcommand((s) =>
            s
              .setName("choose")
              .setDescription("Choose a job")
              .addStringOption((o) => o.setName("job").setDescription("Job key").setRequired(true).setAutocomplete(true)),
          )
          .addSubcommand((s) => s.setName("work").setDescription("Work your job"))
          .addSubcommand((s) => s.setName("resign").setDescription("Resign from your job"))
          .addSubcommand((s) => s.setName("progress").setDescription("View job progress")),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("pets")
          .setDescription("Pets")
          .addSubcommand((s) => s.setName("list").setDescription("List your pets"))
          .addSubcommand((s) =>
            s
              .setName("adopt")
              .setDescription("Adopt a pet")
              .addStringOption((o) => o.setName("species").setDescription("Species key").setRequired(true).setAutocomplete(true))
              .addStringOption((o) => o.setName("name").setDescription("Pet name")),
          )
          .addSubcommand((s) =>
            s
              .setName("info")
              .setDescription("Pet details")
              .addStringOption(idAutocompleteOption("pet", "Your pet")),
          )
          .addSubcommand((s) =>
            s
              .setName("active")
              .setDescription("Set active pet")
              .addStringOption(idAutocompleteOption("pet", "Your pet")),
          )
          .addSubcommand((s) =>
            s
              .setName("feed")
              .setDescription("Feed a pet")
              .addStringOption(idAutocompleteOption("pet", "Your pet")),
          )
          .addSubcommand((s) =>
            s
              .setName("play")
              .setDescription("Play with a pet")
              .addStringOption(idAutocompleteOption("pet", "Your pet")),
          )
          .addSubcommand((s) =>
            s
              .setName("train")
              .setDescription("Train a pet")
              .addStringOption(idAutocompleteOption("pet", "Your pet")),
          )
          .addSubcommand((s) =>
            s
              .setName("adventure")
              .setDescription("Send a pet on an adventure")
              .addStringOption(idAutocompleteOption("pet", "Your pet")),
          )
          .addSubcommand((s) =>
            s
              .setName("battle")
              .setDescription("Battle another pet (no wagers)")
              .addStringOption(idAutocompleteOption("pet", "Your pet"))
              .addStringOption(idAutocompleteOption("opponent", "Opponent pet")),
          )
          .addSubcommand((s) =>
            s
              .setName("rename")
              .setDescription("Rename a pet")
              .addStringOption(idAutocompleteOption("pet", "Your pet"))
              .addStringOption((o) => o.setName("name").setDescription("New name").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("release")
              .setDescription("Release a pet")
              .addStringOption(idAutocompleteOption("pet", "Your pet")),
          ),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("craft")
          .setDescription("Crafting")
          .addSubcommand((s) => s.setName("recipes").setDescription("List recipes"))
          .addSubcommand((s) =>
            s
              .setName("make")
              .setDescription("Start crafting")
              .addStringOption((o) => o.setName("recipe").setDescription("Recipe key").setRequired(true).setAutocomplete(true)),
          )
          .addSubcommand((s) => s.setName("queue").setDescription("View craft queue"))
          .addSubcommand((s) =>
            s
              .setName("collect")
              .setDescription("Collect a finished craft")
              .addStringOption(idAutocompleteOption("id", "Craft in your queue")),
          )
          .addSubcommand((s) =>
            s
              .setName("cancel")
              .setDescription("Cancel a craft")
              .addStringOption(idAutocompleteOption("id", "Craft in your queue")),
          ),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("quests")
          .setDescription("Quests and achievements")
          .addSubcommand((s) => s.setName("list").setDescription("List quests"))
          .addSubcommand((s) => s.setName("progress").setDescription("Your quest progress"))
          .addSubcommand((s) =>
            s
              .setName("claim")
              .setDescription("Claim a completed quest")
              .addStringOption((o) => o.setName("quest").setDescription("Quest key").setRequired(true).setAutocomplete(true)),
          )
          .addSubcommand((s) => s.setName("achievements").setDescription("View achievements")),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("market")
          .setDescription("Player marketplace")
          .addSubcommand((s) => s.setName("browse").setDescription("Browse listings"))
          .addSubcommand((s) =>
            s
              .setName("list")
              .setDescription("List an item for sale")
              .addStringOption((o) => o.setName("item").setDescription("Item key").setRequired(true).setAutocomplete(true))
              .addIntegerOption((o) => o.setName("price").setDescription("Price").setRequired(true).setMinValue(1))
              .addIntegerOption((o) => o.setName("quantity").setDescription("Quantity").setMinValue(1))
              .addStringOption(currencyOption),
          )
          .addSubcommand((s) =>
            s
              .setName("buy")
              .setDescription("Buy a listing")
              .addStringOption(idAutocompleteOption("listing", "Market listing")),
          )
          .addSubcommand((s) =>
            s
              .setName("cancel")
              .setDescription("Cancel your listing")
              .addStringOption(idAutocompleteOption("listing", "Your market listing")),
          )
          .addSubcommand((s) => s.setName("my-listings").setDescription("Your active listings")),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("trade")
          .setDescription("Direct trades")
          .addSubcommand((s) =>
            s
              .setName("start")
              .setDescription("Start a trade")
              .addUserOption((o) => o.setName("user").setDescription("Partner").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("add")
              .setDescription("Add currency or item to a trade")
              .addStringOption(idAutocompleteOption("trade", "Open trade"))
              .addStringOption((o) =>
                o
                  .setName("type")
                  .setDescription("Offer type")
                  .setRequired(true)
                  .addChoices({ name: "currency", value: "currency" }, { name: "item", value: "item" }),
              )
              .addIntegerOption((o) => o.setName("amount").setDescription("Currency amount or item qty").setRequired(true).setMinValue(1))
              .addStringOption((o) => o.setName("currency").setDescription("Currency key").setAutocomplete(true))
              .addStringOption((o) => o.setName("item").setDescription("Item key").setAutocomplete(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("remove")
              .setDescription("Remove an offer from a trade")
              .addStringOption(idAutocompleteOption("offer", "Your trade offer")),
          )
          .addSubcommand((s) =>
            s
              .setName("review")
              .setDescription("Review a trade")
              .addStringOption(idAutocompleteOption("trade", "Open trade")),
          )
          .addSubcommand((s) =>
            s
              .setName("confirm")
              .setDescription("Confirm a trade")
              .addStringOption(idAutocompleteOption("trade", "Open trade")),
          )
          .addSubcommand((s) =>
            s
              .setName("cancel")
              .setDescription("Cancel a trade")
              .addStringOption(idAutocompleteOption("trade", "Open trade")),
          ),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("auction")
          .setDescription("Auctions")
          .addSubcommand((s) => s.setName("browse").setDescription("Browse auctions"))
          .addSubcommand((s) =>
            s
              .setName("create")
              .setDescription("Create an auction")
              .addStringOption((o) => o.setName("item").setDescription("Item key").setRequired(true).setAutocomplete(true))
              .addIntegerOption((o) => o.setName("starting_bid").setDescription("Starting bid").setRequired(true).setMinValue(1))
              .addIntegerOption((o) => o.setName("duration_hours").setDescription("Duration in hours").setRequired(true).setMinValue(1).setMaxValue(168))
              .addIntegerOption((o) => o.setName("quantity").setDescription("Quantity").setMinValue(1))
              .addIntegerOption((o) => o.setName("buyout").setDescription("Buyout price"))
              .addStringOption(currencyOption),
          )
          .addSubcommand((s) =>
            s
              .setName("bid")
              .setDescription("Bid on an auction")
              .addStringOption(idAutocompleteOption("auction", "Auction"))
              .addIntegerOption((o) => o.setName("amount").setDescription("Bid amount").setRequired(true).setMinValue(1)),
          )
          .addSubcommand((s) =>
            s
              .setName("buyout")
              .setDescription("Buy out an auction")
              .addStringOption(idAutocompleteOption("auction", "Auction")),
          )
          .addSubcommand((s) =>
            s
              .setName("cancel")
              .setDescription("Cancel your auction (no bids)")
              .addStringOption(idAutocompleteOption("auction", "Your auction")),
          )
          .addSubcommand((s) =>
            s
              .setName("watch")
              .setDescription("Watch an auction")
              .addStringOption(idAutocompleteOption("auction", "Auction")),
          ),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("leaderboard")
          .setDescription("Economy leaderboards")
          .addSubcommand((s) => s.setName("richest").setDescription("Richest members"))
          .addSubcommand((s) => s.setName("balance").setDescription("Highest pocket balances"))
          .addSubcommand((s) => s.setName("networth").setDescription("Highest net worth"))
          .addSubcommand((s) => s.setName("xp").setDescription("Highest economy XP"))
          .addSubcommand((s) => s.setName("pets").setDescription("Most pets"))
          .addSubcommand((s) => s.setName("season").setDescription("Current season scores")),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("season")
          .setDescription("Seasons")
          .addSubcommand((s) => s.setName("info").setDescription("Active season info"))
          .addSubcommand((s) => s.setName("rewards").setDescription("Season rewards"))
          .addSubcommand((s) => s.setName("progress").setDescription("Your season progress")),
      )
      .addSubcommandGroup((g) =>
        g
          .setName("admin")
          .setDescription("Staff economy tools")
          .addSubcommand((s) =>
            s
              .setName("adjust")
              .setDescription("Add, take, or set balances")
              .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
              .addStringOption((o) =>
                o
                  .setName("mode")
                  .setDescription("Mode")
                  .setRequired(true)
                  .addChoices(
                    { name: "add", value: "add" },
                    { name: "take", value: "take" },
                    { name: "set", value: "set" },
                  ),
              )
              .addIntegerOption((o) => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(0))
              .addStringOption(currencyOption)
              .addStringOption((o) =>
                o
                  .setName("wallet")
                  .setDescription("Wallet")
                  .addChoices({ name: "pocket", value: "pocket" }, { name: "bank", value: "bank" }),
              ),
          )
          .addSubcommand((s) =>
            s
              .setName("freeze")
              .setDescription("Freeze an account")
              .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
              .addStringOption((o) => o.setName("reason").setDescription("Reason")),
          )
          .addSubcommand((s) =>
            s
              .setName("unfreeze")
              .setDescription("Unfreeze an account")
              .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("inspect")
              .setDescription("Inspect an account")
              .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("wipe")
              .setDescription("Wipe a member's economy data")
              .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
              .addStringOption((o) => o.setName("confirm").setDescription('Type "WIPE"').setRequired(true)),
          )
          .addSubcommand((s) => s.setName("pause").setDescription("Pause the economy"))
          .addSubcommand((s) => s.setName("resume").setDescription("Resume the economy"))
          .addSubcommand((s) => s.setName("restock").setDescription("Force shop restock"))
          .addSubcommand((s) => s.setName("settle").setDescription("Settle expired auctions"))
          .addSubcommand((s) => s.setName("seed").setDescription("Seed default catalog and quests")),
      ),
    execute: async (ctx) => {
      const group = ctx.interaction.options.getSubcommandGroup(false);
      const sub = ctx.interaction.options.getSubcommand();
      const perm = permissionFor(group, sub);
      const gate = await auth(ctx, perm);
      if (!gate) return;
      const { config, guildId, userId } = gate;
      const currency =
        ctx.interaction.options.getString("currency") ?? money.getPrimaryCurrencyKey(guildId, config);

      await ctx.interaction.deferReply(deferReplyOptions(ctx.ephemeral));
      try {
        const details = await dispatch({
          group,
          sub,
          ctx,
          config,
          guildId,
          userId,
          currency,
        });
        await ctx.interaction.editReply(
          resultEdit("Economy", details, slashResultOptions(ctx, { tone: "success" })),
        );
      } catch (err) {
        await replyErr(ctx.interaction, ctx, err, true, config);
      }
    },
  },
];

function permissionFor(group: string | null, sub: string): string {
  const map: Record<string, string> = {
    "account:balance": "can_balance",
    "account:bank": "can_bank",
    "account:deposit": "can_bank",
    "account:withdraw": "can_bank",
    "account:history": "can_history",
    "account:profile": "can_profile",
    "account:privacy": "can_profile",
    "rewards:daily": "can_daily",
    "rewards:weekly": "can_weekly",
    "rewards:monthly": "can_monthly",
    "rewards:streak": "can_daily",
    "rewards:work": "can_work",
    "rewards:status": "can_daily",
    "social:pay": "can_pay",
    "social:gift": "can_gift",
    "social:inspect": "can_inspect",
    "shop:browse": "can_shop",
    "shop:item": "can_shop",
    "shop:buy": "can_shop",
    "shop:sell": "can_shop",
    "shop:use": "can_inventory",
    "shop:equip": "can_inventory",
    "shop:unequip": "can_inventory",
    "shop:inventory": "can_inventory",
    "jobs:list": "can_jobs",
    "jobs:choose": "can_jobs",
    "jobs:work": "can_jobs",
    "jobs:resign": "can_jobs",
    "jobs:progress": "can_jobs",
    "pets:list": "can_pets",
    "pets:adopt": "can_pets",
    "pets:info": "can_pets",
    "pets:active": "can_pets",
    "pets:feed": "can_pets",
    "pets:play": "can_pets",
    "pets:train": "can_pets",
    "pets:adventure": "can_pets",
    "pets:battle": "can_pets",
    "pets:rename": "can_pets",
    "pets:release": "can_pets",
    "craft:recipes": "can_craft",
    "craft:make": "can_craft",
    "craft:queue": "can_craft",
    "craft:collect": "can_craft",
    "craft:cancel": "can_craft",
    "quests:list": "can_quests",
    "quests:progress": "can_quests",
    "quests:claim": "can_quests",
    "quests:achievements": "can_quests",
    "market:browse": "can_market",
    "market:list": "can_market",
    "market:buy": "can_market",
    "market:cancel": "can_market",
    "market:my-listings": "can_market",
    "trade:start": "can_trade",
    "trade:add": "can_trade",
    "trade:remove": "can_trade",
    "trade:review": "can_trade",
    "trade:confirm": "can_trade",
    "trade:cancel": "can_trade",
    "auction:browse": "can_auction",
    "auction:create": "can_auction",
    "auction:bid": "can_auction",
    "auction:buyout": "can_auction",
    "auction:cancel": "can_admin_market",
    "auction:watch": "can_auction",
    "leaderboard:richest": "can_leaderboard",
    "leaderboard:balance": "can_leaderboard",
    "leaderboard:networth": "can_leaderboard",
    "leaderboard:xp": "can_leaderboard",
    "leaderboard:pets": "can_leaderboard",
    "leaderboard:season": "can_leaderboard",
    "season:info": "can_season",
    "season:rewards": "can_season",
    "season:progress": "can_season",
    "admin:adjust": "can_admin_adjust",
    "admin:freeze": "can_admin_freeze",
    "admin:unfreeze": "can_admin_freeze",
    "admin:inspect": "can_admin_inspect",
    "admin:wipe": "can_admin_wipe",
    "admin:pause": "can_admin_pause",
    "admin:resume": "can_admin_pause",
    "admin:restock": "can_admin_catalog",
    "admin:settle": "can_admin_market",
    "admin:seed": "can_admin_catalog",
  };
  return map[`${group}:${sub}`] ?? "can_balance";
}

async function dispatch(opts: {
  group: string | null;
  sub: string;
  ctx: {
    interaction: ChatInputCommandInteraction;
    client: import("discord.js").Client;
    guildConfig: import("../../config/schemas/guild.js").GuildConfig;
  };
  config: EconomyConfig;
  guildId: string;
  userId: string;
  currency: string;
}): Promise<string> {
  const { group, sub, ctx, config, guildId, userId, currency } = opts;
  const i = ctx.interaction;

  if (group === "account") {
    if (sub === "balance" || sub === "bank") {
      const target = i.options.getUser("user") ?? i.user;
      const profile = money.ensureProfile(guildId, target.id);
      if (
        target.id !== userId &&
        (profile.hideBalances || config.privacy.hide_balances_by_default) &&
        !(await requirePluginPermission(ctx as never, "economy", "can_admin_inspect"))
      ) {
        throw new EconomyError("That member hides their balances.", "invalid");
      }
      const bal = money.getAccount(guildId, target.id, currency);
      return [`**${target.displayName}'s balance**`, `<@${target.id}>`, "", formatBalances(bal, config, currency)].join("\n");
    }
    if (sub === "deposit") {
      const amount = i.options.getInteger("amount", true);
      const bal = money.depositToBank({ guildId, userId, currencyKey: currency, amount, config });
      return [
        `Deposited **${formatCurrency(amount, config, { currencyKey: currency })}** into your bank.`,
        "",
        formatBalances(bal, config, currency),
      ].join("\n");
    }
    if (sub === "withdraw") {
      const amount = i.options.getInteger("amount", true);
      const bal = money.withdrawFromBank({ guildId, userId, currencyKey: currency, amount, config });
      return [
        `Withdrew **${formatCurrency(amount, config, { currencyKey: currency })}** from your bank.`,
        "",
        formatBalances(bal, config, currency),
      ].join("\n");
    }
    if (sub === "history") {
      const limit = i.options.getInteger("limit") ?? 10;
      const rows = money.listTransactions(guildId, userId, limit);
      if (!rows.length) return "No transactions yet.";
      return rows
        .map(
          (r) =>
            [
              `**\`#${r.id}\` ${r.reason.replaceAll("_", " ")}**`,
              `Pocket: **${r.deltaPocket >= 0 ? "+" : ""}${r.deltaPocket.toLocaleString()}**  •  Balance: **${r.balancePocket.toLocaleString()}**`,
              discordTimestamp(r.createdAt),
            ].join("\n"),
        )
        .join("\n\n");
    }
    if (sub === "profile") {
      const target = i.options.getUser("user") ?? i.user;
      const profile = money.ensureProfile(guildId, target.id);
      const primary = money.getPrimaryCurrencyKey(guildId, config);
      const net = money.getNetWorth(guildId, target.id, primary);
      return [
        `**${target.displayName}'s profile**`,
        `<@${target.id}>`,
        "",
        `**Progression**`,
        `Level **${profile.level}**  •  **${profile.xp.toLocaleString()} XP**  •  Prestige **${profile.prestige}**`,
        "",
        `**Career**`,
        profile.jobKey ? `\`${profile.jobKey}\`  •  Job level **${profile.jobLevel}**` : "No career selected",
        "",
        `**Net worth**`,
        formatCurrency(net, config, { currencyKey: primary }),
        "",
        profile.frozen
          ? `🔒 **Account frozen**\n${profile.freezeReason ?? "No reason provided"}`
          : "✅ **Account active**",
      ].join("\n");
    }
    if (sub === "privacy") {
      const hide = i.options.getBoolean("hide", true);
      money.ensureProfile(guildId, userId);
      const { getDb } = await import("../../db/client.js");
      const { economyProfiles } = await import("../../db/schema.js");
      const { and, eq } = await import("drizzle-orm");
      getDb()
        .update(economyProfiles)
        .set({ hideBalances: hide, updatedAt: new Date() })
        .where(and(eq(economyProfiles.guildId, guildId), eq(economyProfiles.userId, userId)))
        .run();
      return hide
        ? "🔒 Your balances are now **hidden** from other members."
        : "👁️ Your balances are now **visible** to other members.";
    }
  }

  if (group === "rewards") {
    if (sub === "daily" || sub === "weekly" || sub === "monthly") {
      const result = rewards.claimPeriodic({
        guildId,
        userId,
        kind: sub,
        config,
        member: i.member as import("discord.js").GuildMember,
      });
      quests.bumpProgress(guildId, userId, "claim_daily", 1, config);
      return [
        `**${sub[0]!.toUpperCase()}${sub.slice(1)} reward claimed**`,
        `You received **${formatCurrency(result.amount, config, { currencyKey: result.currencyKey })}**.`,
        `🔥 Current streak: **${result.streak}**`,
        `⏳ Next claim ${discordTimestamp(result.nextAt)}`,
      ].join("\n");
    }
    if (sub === "work") {
      const result = rewards.claimWork({
        guildId,
        userId,
        config,
        member: i.member as import("discord.js").GuildMember,
      });
      quests.bumpProgress(guildId, userId, "work", 1, config);
      return [
        "**Shift complete**",
        `You earned **${formatCurrency(result.amount, config, { currencyKey: result.currencyKey })}**.`,
        `⏳ You can work again ${discordTimestamp(result.nextAt)}`,
      ].join("\n");
    }
    if (sub === "streak" || sub === "status") {
      const status = rewards.getRewardStatus(guildId, userId, config);
      const readiness = (entry: { claimed: boolean; nextAt: Date | null }) =>
        entry.claimed
          ? `Claimed · Ready ${discordTimestamp(entry.nextAt ?? new Date())}`
          : "**Available now**";
      return [
        "**Reward status**",
        `${status.daily.claimed ? "☑️" : "✅"} **Daily:** ${readiness(status.daily)}  •  Streak **${status.daily.streak}**`,
        `${status.weekly.claimed ? "☑️" : "✅"} **Weekly:** ${readiness(status.weekly)}`,
        `${status.monthly.claimed ? "☑️" : "✅"} **Monthly:** ${readiness(status.monthly)}`,
        `${status.work.ready ? "✅" : "⏳"} **Work:** ${
          status.work.nextAt ? `Ready ${discordTimestamp(status.work.nextAt)}` : "**Available now**"
        }`,
        status.daily.lastClaimAt
          ? `\nLast daily claim: ${discordTimestamp(status.daily.lastClaimAt)}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
    }
  }

  if (group === "social") {
    if (sub === "pay") {
      const target = i.options.getUser("user", true);
      const amount = i.options.getInteger("amount", true);
      const result = money.transferBetweenUsers({
        guildId,
        fromUserId: userId,
        toUserId: target.id,
        currencyKey: currency,
        amount,
        config,
        actorId: userId,
        idempotencyKey: `pay:${guildId}:${userId}:${target.id}:${Date.now()}`,
      });
      void logEconomy(ctx, "economy_transfer", "Economy transfer", [
        `**From:** <@${userId}>`,
        `**To:** ${target}`,
        `**Amount:** ${amount} ${currency}`,
        `**Tax:** ${result.tax}`,
      ], { guildId, actorId: userId, targetId: target.id });
      quests.bumpProgress(guildId, userId, "pay", 1, config);
      return [
        "**Payment sent**",
        `**Recipient:** <@${target.id}>`,
        `**Amount:** ${formatCurrency(amount, config, { currencyKey: currency })}`,
        result.tax
          ? `**Tax:** ${formatCurrency(result.tax, config, { currencyKey: currency })}`
          : null,
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (sub === "gift") {
      if (!config.inventory.allow_gift) throw new EconomyError("Gifting is disabled.", "invalid");
      const target = i.options.getUser("user", true);
      const itemKey = i.options.getString("item", true);
      const qty = i.options.getInteger("quantity") ?? 1;
      const item = inventory.getItemByKey(guildId, itemKey);
      if (!item) throw new EconomyError("Item not found.", "not_found");
      inventory.removeInventory(guildId, userId, item.id, qty);
      inventory.addInventory(guildId, target.id, item.id, qty, config);
      return `**Gift sent**\n${item.emoji} **${item.name}** × **${qty}**\n**Recipient:** <@${target.id}>`;
    }
    if (sub === "inspect") {
      const target = i.options.getUser("user", true);
      const profile = money.ensureProfile(guildId, target.id);
      const primary = money.getPrimaryCurrencyKey(guildId, config);
      if (profile.hideBalances || config.privacy.hide_balances_by_default) {
        return `**${target.displayName}**\n<@${target.id}>\n\n**Level ${profile.level}**\n🔒 Balances hidden`;
      }
      const bal = money.getAccount(guildId, target.id, primary);
      return `**${target.displayName}**\n<@${target.id}>\n\n**Level ${profile.level}**\n${formatBalances(bal, config, primary)}`;
    }
  }

  if (group === "shop") {
    if (sub === "browse") {
      const shopKey = i.options.getString("shop");
      const shops = inventory.listShops(guildId).filter((s) => s.enabled);
      if (shopKey) {
        const shop = inventory.getShopByKey(guildId, shopKey);
        if (!shop) throw new EconomyError("Shop not found.", "not_found");
        const listings = inventory.listShopListings(guildId, shop.id).filter((l) => l.enabled);
        if (!listings.length) return `${shop.name} has no listings.`;
        return listings
          .map((l) => {
            const item = inventory.getItemById(guildId, l.itemId);
            return `${item?.emoji ?? "📦"} **${item?.name ?? "Unknown item"}**\nPrice: **${formatCurrency(l.price, config, { currencyKey: l.currencyKey })}**  •  Stock: **${l.stock ?? "∞"}**`;
          })
          .join("\n\n");
      }
      return shops.map((s) => `🏪 **${s.name}**\nUse shop key \`${s.key}\``).join("\n\n") || "No shops yet.";
    }
    if (sub === "item") {
      const item = inventory.getItemByKey(guildId, i.options.getString("item", true));
      if (!item) throw new EconomyError("Item not found.", "not_found");
      return [
        `**${item.emoji} ${item.name}**`,
        `\`${item.key}\``,
        "",
        item.description || "*No description provided.*",
        "",
        `**Type:** ${item.itemType}`,
        `**Sell value:** ${formatCurrency(item.sellValue, config, { currencyKey: item.currencyKey })}`,
        `**Tradeable:** ${item.tradeable ? "Yes" : "No"}  •  **Stackable:** ${item.stackable ? "Yes" : "No"}`,
      ].join("\n");
    }
    if (sub === "buy") {
      const result = inventory.buyFromShop({
        guildId,
        userId,
        listingId: parseAutocompleteId(i.options.getString("listing", true), "listing"),
        quantity: i.options.getInteger("quantity") ?? 1,
        config,
      });
      money.addXp(guildId, userId, config.progression.xp_per_purchase, config);
      quests.bumpProgress(guildId, userId, "shop_buy", result.qty, config);
      void logEconomy(ctx, "economy_shop", "Economy shop purchase", [
        `**Buyer:** <@${userId}>`,
        `**Listing:** #${result.listing.id}`,
        `**Total:** ${result.total}`,
      ], { guildId, actorId: userId });
      const item = inventory.getItemById(guildId, result.listing.itemId);
      return `**Purchase complete**\n${item?.emoji ?? "📦"} **${item?.name ?? "Item"}** × **${result.qty}**\n**Total:** ${formatCurrency(result.total, config, { currencyKey: result.listing.currencyKey })}`;
    }
    if (sub === "sell") {
      const item = inventory.getItemByKey(guildId, i.options.getString("item", true));
      if (!item) throw new EconomyError("Item not found.", "not_found");
      const result = inventory.sellItem({
        guildId,
        userId,
        itemId: item.id,
        quantity: i.options.getInteger("quantity") ?? 1,
        config,
      });
      return `**Item sold**\n${result.item.emoji} **${result.item.name}** × **${result.qty}**\n**Received:** ${formatCurrency(result.credit, config, { currencyKey: result.item.currencyKey })}`;
    }
    if (sub === "use") {
      const item = inventory.getItemByKey(guildId, i.options.getString("item", true));
      if (!item) throw new EconomyError("Item not found.", "not_found");
      const result = inventory.useItem({ guildId, userId, itemId: item.id, config });
      const lines = [`**Item used**`, `${result.item.emoji} **${result.item.name}**`];
      if (
        result.effect.type === "boost" &&
        result.effect.multiplier_bps &&
        result.effect.duration_seconds
      ) {
        lines.push(
          `✨ **+${(result.effect.multiplier_bps / 100).toFixed(0)}% rewards** until ${discordTimestamp(
            new Date(Date.now() + result.effect.duration_seconds * 1000),
          )}`,
        );
      }
      for (const drop of result.drops) {
        lines.push(
          drop.kind === "item"
            ? `🎁 You got ${drop.emoji} **${drop.name}** × **${drop.qty}**`
            : `🎁 You got **${formatCurrency(drop.amount, config, { currencyKey: drop.currencyKey })}**`,
        );
      }
      if (result.item.itemType === "crate" && result.drops.length === 0) {
        lines.push("*The crate was empty. Ask an admin to fill its loot pool.*");
      }
      return lines.join("\n");
    }
    if (sub === "equip" || sub === "unequip") {
      const item = inventory.getItemByKey(guildId, i.options.getString("item", true));
      if (!item) throw new EconomyError("Item not found.", "not_found");
      inventory.setEquipped(guildId, userId, item.id, sub === "equip");
      return `${sub === "equip" ? "Equipped" : "Unequipped"} **${item.name}**.`;
    }
    if (sub === "inventory") {
      const target = i.options.getUser("user") ?? i.user;
      const rows = inventory.getInventory(guildId, target.id).filter((r) => r.quantity > 0);
      if (!rows.length) return "Inventory is empty.";
      return rows
        .map((r) => {
          const item = inventory.getItemById(guildId, r.itemId);
          return `${r.equipped ? "🛡️ " : ""}${item?.emoji ?? "📦"} **${item?.name ?? `Item ${r.itemId}`}** × **${r.quantity}**${r.equipped ? "\n*Equipped*" : ""}`;
        })
        .join("\n\n");
    }
  }

  if (group === "jobs") {
    if (sub === "list") {
      const rows = jobs.listJobs(guildId, true);
      return rows
        .map(
          (j) =>
            `${j.emoji} **${j.name}**  •  \`${j.key}\`\nPay: **${formatCurrency(j.payMin, config, { currencyKey: j.currencyKey })} to ${formatCurrency(j.payMax, config, { currencyKey: j.currencyKey })}**`,
        )
        .join("\n\n") || "No jobs configured.";
    }
    if (sub === "choose") {
      jobs.chooseJob(guildId, userId, i.options.getString("job", true), config);
      const profile = money.ensureProfile(guildId, userId);
      return `💼 Career selected: **${profile.jobKey ?? "Unknown"}**.`;
    }
    if (sub === "work") {
      const result = jobs.doJobWork({
        guildId,
        userId,
        config,
      });
      quests.bumpProgress(guildId, userId, "job_work", 1, config);
      return [
        result.failed ? "**Shift failed**" : "**Shift complete**",
        `*${result.flavor}*`,
        "",
        result.paid < 0
          ? `**Fine:** ${formatCurrency(Math.abs(result.paid), config, { currencyKey: result.currencyKey })}`
          : `**Earned:** ${formatCurrency(result.paid, config, { currencyKey: result.currencyKey })}`,
      ].join("\n");
    }
    if (sub === "resign") {
      jobs.resignJob(guildId, userId);
      return "You resigned from your job.";
    }
    if (sub === "progress") {
      const profile = money.ensureProfile(guildId, userId);
      return `**Career progress**\n**Job:** ${profile.jobKey ? `\`${profile.jobKey}\`` : "None"}\n**Level:** ${profile.jobLevel}\n**XP:** ${profile.jobXp.toLocaleString()}`;
    }
  }

  if (group === "pets") {
    const petId = (() => { const raw = i.options.getString("pet"); return raw ? parseAutocompleteId(raw, "pet") : 0; })();
    if (sub === "list") {
      const owned = pets.listOwnedPets(guildId, userId);
      const activePetId = money.ensureProfile(guildId, userId).activePetId;
      return owned
        .map((p) => {
          const species = pets.getSpeciesById(guildId, p.speciesId);
          return `${species?.emoji ?? "🐾"} **${p.name}**\nLevel **${p.level}**${p.id === activePetId ? "  •  ⭐ Active" : ""}`;
        })
        .join("\n\n") || "You have no pets.";
    }
    if (sub === "adopt") {
      const pet = pets.adoptPet({
        guildId,
        userId,
        speciesKey: i.options.getString("species", true),
        name: i.options.getString("name") ?? undefined,
        config,
      });
      return `**New pet adopted**\n🐾 Meet **${pet.pet.name}**!`;
    }
    if (sub === "info") {
      const pet = pets.lazyTickPet(petId, guildId, config);
      return [
        `**🐾 ${pet.name}**`,
        `Level **${pet.level}**`,
        "",
        `**Care**`,
        `🍖 Hunger **${pet.hunger}**  •  ⚡ Energy **${pet.energy}**  •  💛 Happiness **${pet.happiness}**`,
        "",
        `**Stats**`,
        `⚔️ ATK **${pet.atk}**  •  🛡️ DEF **${pet.def}**  •  ❤️ HP **${pet.hp}**  •  💨 SPD **${pet.speed}**`,
      ].join("\n");
    }
    if (sub === "active") {
      pets.setActivePet(guildId, userId, petId);
      const pet = pets.getPet(guildId, petId);
      return `⭐ **${pet?.name ?? "Pet"}** is now your active pet.`;
    }
    if (sub === "feed") {
      const result = pets.feedPet({ guildId, userId, petId, config });
      return `🍖 Fed **${result.pet.name}**.`;
    }
    if (sub === "play") {
      const result = pets.playWithPet({ guildId, userId, petId, config });
      return `🎾 Played with **${result.pet.name}**.`;
    }
    if (sub === "train") {
      const result = pets.trainPet({ guildId, userId, petId, config });
      return `💪 **${result.pet.name}** finished training.`;
    }
    if (sub === "adventure") {
      const result = pets.adventurePet({ guildId, userId, petId, config });
      const pet = pets.getPet(guildId, petId);
      return result.success
        ? `**Adventure complete**\n**${pet?.name ?? "Your pet"}** returned with **${formatCurrency(result.reward, config, { currencyKey: result.currencyKey })}**.`
        : `**Adventure unsuccessful**\n**${pet?.name ?? "Your pet"}** returned safely, but found no reward this time.`;
    }
    if (sub === "battle") {
      const result = pets.battlePets({
        guildId,
        challengerUserId: userId,
        challengerPetId: petId,
        opponentPetId: parseAutocompleteId(i.options.getString("opponent", true), "opponent pet"),
        config,
      });
      const winner = pets.getPet(guildId, result.winnerPetId);
      return [
        result.challengerWon ? "**🏆 Battle won**" : "**Battle lost**",
        `**Winner:** **${winner?.name ?? "Pet"}**`,
        `**Score:** ${result.scoreA} to ${result.scoreB}`,
      ].join("\n");
    }
    if (sub === "rename") {
      const name = i.options.getString("name", true);
      pets.renamePet(guildId, userId, petId, name, config);
      return `✏️ Your pet was renamed to **${name}**.`;
    }
    if (sub === "release") {
      const pet = pets.releasePet(guildId, userId, petId, config);
      return `Released **${pet.name}**.`;
    }
  }

  if (group === "craft") {
    if (sub === "recipes") {
      return (
        crafting
          .listRecipes(guildId, true)
          .map((r) => `🧰 **${r.name}**  •  \`${r.key}\`\nCraft time: **${formatDuration(r.durationSeconds * 1000)}**`)
          .join("\n\n") || "No recipes."
      );
    }
    if (sub === "make") {
      const entry = crafting.startCraft({
        guildId,
        userId,
        recipeKey: i.options.getString("recipe", true),
        config,
      });
      quests.bumpProgress(guildId, userId, "craft", 1, config);
      const recipe = crafting.getRecipeById(guildId, entry.entry.recipeId);
      return [
        "**Crafting started**",
        `**Recipe:** ${recipe?.name ?? "Unknown"}`,
        `**Ready:** ${discordTimestamp(entry.entry.completesAt)}`,
      ].join("\n");
    }
    if (sub === "queue") {
      const queue = crafting.listQueue(guildId, userId, true);
      return (
        queue
          .map((q) => {
            const recipe = crafting.getRecipeById(guildId, q.recipeId);
            const status = q.cancelled
              ? "❌ Cancelled"
              : q.collected
                ? "✅ Collected"
                : q.completesAt.getTime() <= Date.now()
                  ? "📦 **Ready to collect**"
                  : `⏳ Ready ${discordTimestamp(q.completesAt)}`;
            return `🧰 **${recipe?.name ?? "Craft"}**\n${status}`;
          })
          .join("\n\n") || "Queue empty."
      );
    }
    if (sub === "collect") {
      const craftId = parseAutocompleteId(i.options.getString("id", true), "craft");
      const before = crafting.getCraftEntry(guildId, craftId);
      const recipe = before ? crafting.getRecipeById(guildId, before.recipeId) : null;
      crafting.collectCraft({ guildId, userId, craftId, config });
      return `📦 Collected **${recipe?.name ?? "craft"}**.`;
    }
    if (sub === "cancel") {
      const craftId = parseAutocompleteId(i.options.getString("id", true), "craft");
      const before = crafting.getCraftEntry(guildId, craftId);
      const recipe = before ? crafting.getRecipeById(guildId, before.recipeId) : null;
      crafting.cancelCraft({ guildId, userId, craftId, config });
      return `Cancelled **${recipe?.name ?? "craft"}**.`;
    }
  }

  if (group === "quests") {
    if (sub === "list") {
      return (
        quests
          .listQuests(guildId, true)
          .map(
            (q) =>
              `📜 **${q.name}**  •  \`${q.key}\`\n${q.description || "*No description*"}\n**Resets:** ${q.questType}`,
          )
          .join("\n\n") || "No quests."
      );
    }
    if (sub === "progress") {
      const rows = quests.listQuestProgress(guildId, userId, config);
      return (
        rows
          .map((r) => {
            const complete = r.progress.progress >= r.quest.objectiveTarget;
            return `${r.progress.claimed ? "☑️" : complete ? "✅" : "⬜"} **${r.quest.name}**\nProgress: **${r.progress.progress}/${r.quest.objectiveTarget}**${r.progress.claimed ? "  •  Claimed" : complete ? "  •  Ready to claim" : ""}`;
          })
          .join("\n\n") || "No progress yet."
      );
    }
    if (sub === "claim") {
      const result = quests.claimQuest({
        guildId,
        userId,
        questKey: i.options.getString("quest", true),
        config,
      });
      return `**Quest complete**\n📜 **${result.quest.name}**\n**Reward:** ${formatCurrency(result.rewardAmount, config, { currencyKey: result.quest.rewardCurrencyKey })}`;
    }
    if (sub === "achievements") {
      return (
        quests
          .listAchievements(guildId, true)
          .map((a) => `🏅 **${a.name}**  •  \`${a.key}\`\n${a.description || "*No description*"}`)
          .join("\n\n") || "No achievements."
      );
    }
  }

  if (group === "market") {
    if (sub === "browse" || sub === "my-listings") {
      const rows = markets
        .listMarketListings(guildId)
        .filter((l) => (sub === "my-listings" ? l.sellerId === userId : true));
      return (
        rows
          .map((l) => {
            const item = inventory.getItemById(guildId, l.itemId);
            return `${item?.emoji ?? "📦"} **${item?.name ?? "Unknown item"}** × **${l.quantity}**\n**Price:** ${formatCurrency(l.price, config, { currencyKey: l.currencyKey })}\n**Seller:** <@${l.sellerId}>`;
          })
          .join("\n\n") || "No listings."
      );
    }
    if (sub === "list") {
      const item = inventory.getItemByKey(guildId, i.options.getString("item", true));
      if (!item) throw new EconomyError("Item not found.", "not_found");
      const listing = markets.createMarketListing({
        guildId,
        sellerId: userId,
        itemId: item.id,
        quantity: i.options.getInteger("quantity") ?? 1,
        price: i.options.getInteger("price", true),
        currencyKey: currency,
        config,
      });
      return `**Market listing created**\n${item.emoji} **${item.name}** × **${listing.listing.quantity}**\n**Price:** ${formatCurrency(listing.listing.price, config, { currencyKey: listing.listing.currencyKey })}`;
    }
    if (sub === "buy") {
      const listingId = parseAutocompleteId(i.options.getString("listing", true), "listing");
      const before = markets.listMarketListings(guildId).find((l) => l.id === listingId);
      const item = before ? inventory.getItemById(guildId, before.itemId) : null;
      markets.buyMarketListing({
        guildId,
        buyerId: userId,
        listingId,
        config,
      });
      return `✅ Purchased ${item?.emoji ?? "📦"} **${item?.name ?? "listing"}**.`;
    }
    if (sub === "cancel") {
      const listingId = parseAutocompleteId(i.options.getString("listing", true), "listing");
      const before = markets.listMarketListings(guildId).find((l) => l.id === listingId);
      const item = before ? inventory.getItemById(guildId, before.itemId) : null;
      markets.cancelMarketListing({
        guildId,
        userId,
        listingId,
        config,
      });
      return `Cancelled listing for ${item?.emoji ?? "📦"} **${item?.name ?? "item"}**.`;
    }
  }

  if (group === "trade") {
    if (sub === "start") {
      const partner = i.options.getUser("user", true);
      markets.startTrade({
        guildId,
        initiatorId: userId,
        partnerId: partner.id,
        config,
      });
      return `**Trade started**\n**Partner:** <@${partner.id}>\n\nUse \`/economy trade add\` to build your offer.`;
    }
    if (sub === "add") {
      const type = i.options.getString("type", true) as "currency" | "item";
      const itemKey = i.options.getString("item");
      const item = itemKey ? inventory.getItemByKey(guildId, itemKey) : null;
      const tradeId = parseAutocompleteId(i.options.getString("trade", true), "trade");
      markets.addTradeOffer({
        guildId,
        tradeId,
        userId,
        offerType: type,
        amount: type === "currency" ? i.options.getInteger("amount", true) : 0,
        currencyKey: currency,
        itemId: item?.id,
        quantity: type === "item" ? i.options.getInteger("amount", true) : 0,
        config,
      });
      return type === "item"
        ? `✅ Added ${item?.emoji ?? "📦"} **${item?.name ?? "item"}** to the trade.`
        : `✅ Added **${formatCurrency(i.options.getInteger("amount", true), config, { currencyKey: currency })}** to the trade.`;
    }
    if (sub === "remove") {
      const offerId = parseAutocompleteId(i.options.getString("offer", true), "offer");
      const { getDb } = await import("../../db/client.js");
      const { economyTradeOffers } = await import("../../db/schema.js");
      const { eq } = await import("drizzle-orm");
      const offer = getDb().select().from(economyTradeOffers).where(eq(economyTradeOffers.id, offerId)).get();
      if (!offer) throw new EconomyError("Offer not found.", "not_found");
      markets.removeTradeOffer({
        guildId,
        tradeId: offer.tradeId,
        offerId,
        userId,
        config,
      });
      return "Offer removed from the trade.";
    }
    if (sub === "review") {
      const review = markets.reviewTrade(parseAutocompleteId(i.options.getString("trade", true), "trade"));
      return [
        `**Open trade**`,
        `**Status:** ${review.trade.status}`,
        `**Members:** <@${review.trade.initiatorId}> and <@${review.trade.partnerId}>`,
        "",
        `**Offers (${review.offers.length})**`,
        review.offers.length
          ? review.offers
              .map((offer) => {
                if (offer.offerType === "currency") {
                  return `• <@${offer.userId}>: **${formatCurrency(offer.amount, config, { currencyKey: offer.currencyKey ?? "coins" })}**`;
                }
                const item = offer.itemId ? inventory.getItemById(guildId, offer.itemId) : null;
                return `• <@${offer.userId}>: ${item?.emoji ?? "📦"} **${item?.name ?? "Item"}** × **${offer.quantity}**`;
              })
              .join("\n")
          : "*No offers yet.*",
      ].join("\n");
    }
    if (sub === "confirm") {
      const tradeId = parseAutocompleteId(i.options.getString("trade", true), "trade");
      const result = markets.confirmTrade({
        guildId,
        tradeId,
        userId,
        config,
      });
      void logEconomy(ctx, "economy_trade", "Economy trade", [
        `**Trade:** #${tradeId}`,
        `**By:** <@${userId}>`,
        `**Completed:** ${result.completed ? "yes" : "pending"}`,
      ], { guildId, actorId: userId });
      return result.completed
        ? "✅ Trade **completed**."
        : "☑️ Trade confirmed.\nWaiting for the other member to confirm.";
    }
    if (sub === "cancel") {
      markets.cancelTrade({
        guildId,
        tradeId: parseAutocompleteId(i.options.getString("trade", true), "trade"),
        userId,
        config,
      });
      return "Trade cancelled.";
    }
  }

  if (group === "auction") {
    if (sub === "browse") {
      const rows = markets.listAuctions(guildId);
      return (
        rows
          .map((a) => {
            const item = inventory.getItemById(guildId, a.itemId);
            const bid = a.currentBid || a.startingBid;
            return [
              `${item?.emoji ?? "📦"} **${item?.name ?? "Unknown item"}** × **${a.quantity}**`,
              `**Current bid:** ${formatCurrency(bid, config, { currencyKey: a.currencyKey })}`,
              `**Seller:** <@${a.sellerId}>`,
              `**Ends:** ${discordTimestamp(a.endsAt)}`,
            ].join("\n");
          })
          .join("\n\n") || "No auctions."
      );
    }
    if (sub === "create") {
      const item = inventory.getItemByKey(guildId, i.options.getString("item", true));
      if (!item) throw new EconomyError("Item not found.", "not_found");
      const auction = markets.createAuction({
        guildId,
        sellerId: userId,
        itemId: item.id,
        quantity: i.options.getInteger("quantity") ?? 1,
        startingBid: i.options.getInteger("starting_bid", true),
        buyoutPrice: i.options.getInteger("buyout") ?? null,
        durationSeconds: i.options.getInteger("duration_hours", true) * 3600,
        currencyKey: currency,
        config,
      });
      return [
        "**Auction created**",
        `${item.emoji} **${item.name}** × **${auction.quantity}**`,
        `**Starting bid:** ${formatCurrency(auction.startingBid, config, { currencyKey: auction.currencyKey })}`,
        auction.buyoutPrice
          ? `**Buyout:** ${formatCurrency(auction.buyoutPrice, config, { currencyKey: auction.currencyKey })}`
          : null,
        `**Ends:** ${discordTimestamp(auction.endsAt)}`,
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (sub === "bid") {
      const auctionId = parseAutocompleteId(i.options.getString("auction", true), "auction");
      const amount = i.options.getInteger("amount", true);
      const auction = markets.bidOnAuction({
        guildId,
        auctionId,
        bidderId: userId,
        amount,
        config,
      });
      const item = inventory.getItemById(guildId, auction.itemId);
      return [
        "**Bid placed**",
        `${item?.emoji ?? "📦"} **${item?.name ?? "Auction item"}**`,
        `**Your bid:** ${formatCurrency(amount, config, { currencyKey: auction.currencyKey })}`,
        `**Ends:** ${discordTimestamp(auction.endsAt)}`,
      ].join("\n");
    }
    if (sub === "buyout") {
      const auctionId = parseAutocompleteId(i.options.getString("auction", true), "auction");
      const before = markets.getAuction(guildId, auctionId);
      const item = before ? inventory.getItemById(guildId, before.itemId) : null;
      markets.buyoutAuction({
        guildId,
        auctionId,
        buyerId: userId,
        config,
      });
      void logEconomy(ctx, "economy_auction", "Economy auction buyout", [
        `**Auction:** #${auctionId}`,
        `**Buyer:** <@${userId}>`,
      ], { guildId, actorId: userId });
      return `✅ Bought out ${item?.emoji ?? "📦"} **${item?.name ?? "auction"}**.`;
    }
    if (sub === "cancel") {
      const auction = markets.getAuction(guildId, parseAutocompleteId(i.options.getString("auction", true), "auction"));
      if (!auction || auction.sellerId !== userId) throw new EconomyError("Auction not found.", "not_found");
      if (auction.currentBidderId) throw new EconomyError("Cannot cancel after bids.", "invalid");
      const item = inventory.getItemById(guildId, auction.itemId);
      markets.settleAuction(guildId, auction.id, config);
      return `Cancelled auction for ${item?.emoji ?? "📦"} **${item?.name ?? "item"}** and returned it.`;
    }
    if (sub === "watch") {
      const auctionId = parseAutocompleteId(i.options.getString("auction", true), "auction");
      const auction = markets.getAuction(guildId, auctionId);
      const item = auction ? inventory.getItemById(guildId, auction.itemId) : null;
      markets.watchAuction(guildId, auctionId, userId);
      return `👀 Watching ${item?.emoji ?? "📦"} **${item?.name ?? "auction"}**.\nYou will be notified when it changes.`;
    }
  }

  if (group === "leaderboard") {
    if (sub === "season") {
      const active = seasons.getActiveSeason(guildId);
      if (!active) return "No active season.";
      const board = seasons.getSeasonLeaderboard(guildId, active.id, 10);
      return board
        .map((r, idx) => `${rankMark(idx)} <@${r.userId}>\n**${r.score.toLocaleString()} points**`)
        .join("\n\n") || "No scores.";
    }
    if (sub === "xp") {
      const { getDb } = await import("../../db/client.js");
      const { economyProfiles } = await import("../../db/schema.js");
      const { eq, desc } = await import("drizzle-orm");
      const rows = getDb()
        .select()
        .from(economyProfiles)
        .where(eq(economyProfiles.guildId, guildId))
        .orderBy(desc(economyProfiles.level), desc(economyProfiles.xp))
        .limit(10)
        .all();
      return rows
        .map((r, idx) => `${rankMark(idx)} <@${r.userId}>\nLevel **${r.level}**  •  **${r.xp.toLocaleString()} XP**`)
        .join("\n\n") || "Empty.";
    }
    if (sub === "pets") {
      const { getDb } = await import("../../db/client.js");
      const { economyPets } = await import("../../db/schema.js");
      const { eq, sql } = await import("drizzle-orm");
      const rows = getDb()
        .select({
          userId: economyPets.userId,
          count: sql<number>`count(*)`,
        })
        .from(economyPets)
        .where(eq(economyPets.guildId, guildId))
        .groupBy(economyPets.userId)
        .orderBy(sql`count(*) DESC`)
        .limit(10)
        .all();
      return rows
        .map((r, idx) => `${rankMark(idx)} <@${r.userId}>\n🐾 **${r.count.toLocaleString()} pets**`)
        .join("\n\n") || "Empty.";
    }
    const primary = money.getPrimaryCurrencyKey(guildId, config);
    const board = money.leaderboardRichest(guildId, primary, 10);
    return board
      .map(
        (r, idx) =>
          `${rankMark(idx)} <@${r.userId}>\n**${formatCurrency(Number(r.total), config, { currencyKey: primary })}**`,
      )
      .join("\n\n") || "Empty.";
  }

  if (group === "season") {
    const active = seasons.getActiveSeason(guildId);
    if (!active) return "No active season.";
    if (sub === "info") {
      return [
        `**🏆 ${active.name}**`,
        `\`${active.key}\``,
        "",
        active.description || "*No description provided.*",
        "",
        `**Starts:** ${discordTimestamp(active.startsAt, "F")}`,
        `**Ends:** ${discordTimestamp(active.endsAt)}`,
      ].join("\n");
    }
    if (sub === "rewards") {
      const parsed = JSON.parse(active.rewardsJson) as Array<{
        minRank?: number;
        maxRank?: number;
        amount?: number;
      }>;
      return [
        `**${active.name} rewards**`,
        ...parsed.map((reward) => {
          const placement =
            reward.minRank === reward.maxRank
              ? `#${reward.minRank}`
              : `#${reward.minRank ?? "?"} to #${reward.maxRank ?? "?"}`;
          return `🏅 **${placement}:** ${Number(reward.amount ?? 0).toLocaleString()}`;
        }),
      ].join("\n");
    }
    if (sub === "progress") {
      const score = seasons.getUserSeasonScore(guildId, active.id, userId);
      return `**Your season progress**\n**Score:** ${(score?.score ?? 0).toLocaleString()}\n**Reward:** ${score?.claimed ? "☑️ Claimed" : "Not claimed"}`;
    }
  }

  if (group === "admin") {
    if (sub === "adjust") {
      const target = i.options.getUser("user", true);
      const mode = i.options.getString("mode", true) as "add" | "take" | "set";
      const amount = i.options.getInteger("amount", true);
      const wallet = i.options.getString("wallet") ?? "pocket";
      const bal = money.adminAdjust({
        guildId,
        userId: target.id,
        currencyKey: currency,
        mode,
        actorId: userId,
        config,
        pocketDelta: wallet === "pocket" ? amount : undefined,
        bankDelta: wallet === "bank" ? amount : undefined,
      });
      void logEconomy(ctx, "economy_adjust", "Economy adjust", [
        `**Staff:** <@${userId}>`,
        `**Target:** ${target}`,
        `**Mode:** ${mode}`,
        `**Amount:** ${amount} ${currency} (${wallet})`,
      ], { guildId, actorId: userId, targetId: target.id });
      return [
        "**Balance adjusted**",
        `**Member:** <@${target.id}>`,
        `**Action:** ${mode} ${formatCurrency(amount, config, { currencyKey: currency })} in ${wallet}`,
        "",
        formatBalances(bal, config, currency),
      ].join("\n");
    }
    if (sub === "freeze" || sub === "unfreeze") {
      const target = i.options.getUser("user", true);
      money.setAccountFrozen(guildId, target.id, sub === "freeze", i.options.getString("reason") ?? undefined);
      void logEconomy(ctx, "economy_freeze", sub === "freeze" ? "Economy freeze" : "Economy unfreeze", [
        `**Staff:** <@${userId}>`,
        `**Target:** ${target}`,
      ], { guildId, actorId: userId, targetId: target.id });
      return sub === "freeze"
        ? `🔒 Froze <@${target.id}>'s economy account.`
        : `🔓 Unfroze <@${target.id}>'s economy account.`;
    }
    if (sub === "inspect") {
      const target = i.options.getUser("user", true);
      const profile = money.ensureProfile(guildId, target.id);
      const primary = money.getPrimaryCurrencyKey(guildId, config);
      const bal = money.getAccount(guildId, target.id, primary);
      return [
        `**Account inspection**`,
        `**Member:** <@${target.id}>`,
        `**User ID:** \`${target.id}\``,
        "",
        formatBalances(bal, config, primary),
        "",
        `**Status:** ${profile.frozen ? "🔒 Frozen" : "✅ Active"}`,
        `**Level:** ${profile.level}  •  **Job:** ${profile.jobKey ? `\`${profile.jobKey}\`` : "None"}`,
      ].join("\n");
    }
    if (sub === "wipe") {
      if (i.options.getString("confirm", true) !== "WIPE") {
        throw new EconomyError('Type confirm: WIPE', "invalid");
      }
      const target = i.options.getUser("user", true);
      const { getDb } = await import("../../db/client.js");
      const schema = await import("../../db/schema.js");
      const { and, eq } = await import("drizzle-orm");
      const db = getDb();
      db.delete(schema.economyAccounts)
        .where(and(eq(schema.economyAccounts.guildId, guildId), eq(schema.economyAccounts.userId, target.id)))
        .run();
      db.delete(schema.economyInventory)
        .where(and(eq(schema.economyInventory.guildId, guildId), eq(schema.economyInventory.userId, target.id)))
        .run();
      db.delete(schema.economyProfiles)
        .where(and(eq(schema.economyProfiles.guildId, guildId), eq(schema.economyProfiles.userId, target.id)))
        .run();
      return `🗑️ Wiped all economy data for <@${target.id}> (\`${target.id}\`).`;
    }
    if (sub === "pause" || sub === "resume") {
      money.setGuildPaused(guildId, sub === "pause");
      return sub === "pause"
        ? "⏸️ The server economy is now **paused**."
        : "▶️ The server economy is now **running**.";
    }
    if (sub === "restock") {
      const n = inventory.restockDueListings(guildId);
      return `📦 Restocked **${n.toLocaleString()}** shop ${n === 1 ? "listing" : "listings"}.`;
    }
    if (sub === "settle") {
      const n = markets.settleExpiredAuctions(guildId, config);
      return `⚖️ Settled **${n.toLocaleString()}** expired ${n === 1 ? "auction" : "auctions"}.`;
    }
    if (sub === "seed") {
      inventory.seedDefaultCatalog(guildId);
      quests.seedDefaultQuests(guildId);
      return "🌱 Seeded the **default catalog and quests**.";
    }
  }

  throw new EconomyError("Unknown subcommand.", "invalid");
}

function rankMark(index: number): string {
  return ["🥇", "🥈", "🥉"][index] ?? `**${index + 1}.**`;
}
