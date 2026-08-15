import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { SlashCommandDefinition } from "../../core/types.js";
import { requirePluginPermission } from "../../core/pluginCommand.js";
import { deferReplyOptions, resultEdit, resultReply, slashResultOptions } from "../../core/responses.js";
import { zEconomyConfig, type EconomyConfig } from "../../config/schemas/economy.js";
import { emitLog } from "../../core/logging/send.js";
import { shortEconomyError, formatBalances, formatCurrency } from "./functions/format.js";
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

async function logEconomy(
  ctx: {
    client: import("discord.js").Client;
    guildConfig: import("../../config/schemas/guild.js").GuildConfig;
  },
  eventType:
    | "economy_adjust"
    | "economy_transfer"
    | "economy_shop"
    | "economy_trade"
    | "economy_auction"
    | "economy_freeze"
    | "economy_season",
  title: string,
  information: string[],
  meta: { guildId: string; actorId?: string; targetId?: string; summary?: string },
) {
  await emitLog(
    ctx.client,
    ctx.guildConfig,
    { title, information },
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
) {
  const msg = shortEconomyError(err);
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

export const economyCommands: SlashCommandDefinition[] = [
  {
    plugin: "economy",
    data: new SlashCommandBuilder()
      .setName("economy")
      .setDescription("Server economy — balances, rewards, shops, pets, markets, and more")
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
              .addIntegerOption((o) => o.setName("listing").setDescription("Listing ID").setRequired(true))
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
              .addIntegerOption((o) => o.setName("pet").setDescription("Pet ID").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("active")
              .setDescription("Set active pet")
              .addIntegerOption((o) => o.setName("pet").setDescription("Pet ID").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("feed")
              .setDescription("Feed a pet")
              .addIntegerOption((o) => o.setName("pet").setDescription("Pet ID").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("play")
              .setDescription("Play with a pet")
              .addIntegerOption((o) => o.setName("pet").setDescription("Pet ID").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("train")
              .setDescription("Train a pet")
              .addIntegerOption((o) => o.setName("pet").setDescription("Pet ID").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("adventure")
              .setDescription("Send a pet on an adventure")
              .addIntegerOption((o) => o.setName("pet").setDescription("Pet ID").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("battle")
              .setDescription("Battle another pet (no wagers)")
              .addIntegerOption((o) => o.setName("pet").setDescription("Your pet ID").setRequired(true))
              .addIntegerOption((o) => o.setName("opponent").setDescription("Opponent pet ID").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("rename")
              .setDescription("Rename a pet")
              .addIntegerOption((o) => o.setName("pet").setDescription("Pet ID").setRequired(true))
              .addStringOption((o) => o.setName("name").setDescription("New name").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("release")
              .setDescription("Release a pet")
              .addIntegerOption((o) => o.setName("pet").setDescription("Pet ID").setRequired(true)),
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
              .addIntegerOption((o) => o.setName("id").setDescription("Craft queue ID").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("cancel")
              .setDescription("Cancel a craft")
              .addIntegerOption((o) => o.setName("id").setDescription("Craft queue ID").setRequired(true)),
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
              .addIntegerOption((o) => o.setName("listing").setDescription("Listing ID").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("cancel")
              .setDescription("Cancel your listing")
              .addIntegerOption((o) => o.setName("listing").setDescription("Listing ID").setRequired(true)),
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
              .addIntegerOption((o) => o.setName("trade").setDescription("Trade ID").setRequired(true))
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
              .addIntegerOption((o) => o.setName("offer").setDescription("Offer ID").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("review")
              .setDescription("Review a trade")
              .addIntegerOption((o) => o.setName("trade").setDescription("Trade ID").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("confirm")
              .setDescription("Confirm a trade")
              .addIntegerOption((o) => o.setName("trade").setDescription("Trade ID").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("cancel")
              .setDescription("Cancel a trade")
              .addIntegerOption((o) => o.setName("trade").setDescription("Trade ID").setRequired(true)),
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
              .addIntegerOption((o) => o.setName("auction").setDescription("Auction ID").setRequired(true))
              .addIntegerOption((o) => o.setName("amount").setDescription("Bid amount").setRequired(true).setMinValue(1)),
          )
          .addSubcommand((s) =>
            s
              .setName("buyout")
              .setDescription("Buy out an auction")
              .addIntegerOption((o) => o.setName("auction").setDescription("Auction ID").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("cancel")
              .setDescription("Cancel your auction (no bids)")
              .addIntegerOption((o) => o.setName("auction").setDescription("Auction ID").setRequired(true)),
          )
          .addSubcommand((s) =>
            s
              .setName("watch")
              .setDescription("Watch an auction")
              .addIntegerOption((o) => o.setName("auction").setDescription("Auction ID").setRequired(true)),
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
        await replyErr(ctx.interaction, ctx, err, true);
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
      return `**${target.username}** — ${formatBalances(bal, config, currency)}`;
    }
    if (sub === "deposit") {
      const amount = i.options.getInteger("amount", true);
      const bal = money.depositToBank({ guildId, userId, currencyKey: currency, amount, config });
      return `Deposited. ${formatBalances(bal, config, currency)}`;
    }
    if (sub === "withdraw") {
      const amount = i.options.getInteger("amount", true);
      const bal = money.withdrawFromBank({ guildId, userId, currencyKey: currency, amount, config });
      return `Withdrew. ${formatBalances(bal, config, currency)}`;
    }
    if (sub === "history") {
      const limit = i.options.getInteger("limit") ?? 10;
      const rows = money.listTransactions(guildId, userId, limit);
      if (!rows.length) return "No transactions yet.";
      return rows
        .map(
          (r) =>
            `#${r.id} \`${r.reason}\` pocket ${r.deltaPocket >= 0 ? "+" : ""}${r.deltaPocket} → ${r.balancePocket}`,
        )
        .join("\n");
    }
    if (sub === "profile") {
      const target = i.options.getUser("user") ?? i.user;
      const profile = money.ensureProfile(guildId, target.id);
      const primary = money.getPrimaryCurrencyKey(guildId, config);
      const net = money.getNetWorth(guildId, target.id, primary);
      return [
        `**${target.username}**`,
        `Level ${profile.level} · ${profile.xp} XP · Prestige ${profile.prestige}`,
        `Job: ${profile.jobKey ?? "none"} (Lv ${profile.jobLevel})`,
        `Net worth: ${formatCurrency(net, config, { currencyKey: primary })}`,
        profile.frozen ? `Frozen: ${profile.freezeReason ?? "yes"}` : "Account active",
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
      return hide ? "Balances are now hidden from others." : "Balances are now visible.";
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
      return `Claimed ${formatCurrency(result.amount, config, { currencyKey: result.currencyKey })} (streak ${result.streak}).`;
    }
    if (sub === "work") {
      const result = rewards.claimWork({
        guildId,
        userId,
        config,
        member: i.member as import("discord.js").GuildMember,
      });
      quests.bumpProgress(guildId, userId, "work", 1, config);
      return `You earned ${formatCurrency(result.amount, config, { currencyKey: result.currencyKey })}.`;
    }
    if (sub === "streak" || sub === "status") {
      const status = rewards.getRewardStatus(guildId, userId, config);
      return [
        `Daily: ${status.daily.claimed ? "claimed" : "available"} · streak ${status.daily.streak}`,
        `Weekly: ${status.weekly.claimed ? "claimed" : "available"}`,
        `Monthly: ${status.monthly.claimed ? "claimed" : "available"}`,
      ].join("\n");
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
      return `Paid ${target} ${formatCurrency(amount, config, { currencyKey: currency })}${result.tax ? ` (tax ${result.tax})` : ""}.`;
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
      return `Gifted ${qty}× ${item.name} to ${target}.`;
    }
    if (sub === "inspect") {
      const target = i.options.getUser("user", true);
      const profile = money.ensureProfile(guildId, target.id);
      const primary = money.getPrimaryCurrencyKey(guildId, config);
      if (profile.hideBalances || config.privacy.hide_balances_by_default) {
        return `**${target.username}** · Level ${profile.level} · balances hidden`;
      }
      const bal = money.getAccount(guildId, target.id, primary);
      return `**${target.username}** · Level ${profile.level}\n${formatBalances(bal, config, primary)}`;
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
            return `#${l.id} ${item?.name ?? "?"} — ${formatCurrency(l.price, config, { currencyKey: l.currencyKey })} (stock ${l.stock ?? "∞"})`;
          })
          .join("\n");
      }
      return shops.map((s) => `\`${s.key}\` — **${s.name}**`).join("\n") || "No shops yet.";
    }
    if (sub === "item") {
      const item = inventory.getItemByKey(guildId, i.options.getString("item", true));
      if (!item) throw new EconomyError("Item not found.", "not_found");
      return `**${item.name}** (\`${item.key}\`)\n${item.description || "No description."}\nType: ${item.itemType} · Sell: ${item.sellValue}`;
    }
    if (sub === "buy") {
      const result = inventory.buyFromShop({
        guildId,
        userId,
        listingId: i.options.getInteger("listing", true),
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
      return `Bought ${result.qty}× item for ${formatCurrency(result.total, config, { currencyKey: result.listing.currencyKey })}.`;
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
      return `Sold ${result.qty}× ${result.item.name} for ${formatCurrency(result.credit, config, { currencyKey: result.item.currencyKey })}.`;
    }
    if (sub === "use") {
      const item = inventory.getItemByKey(guildId, i.options.getString("item", true));
      if (!item) throw new EconomyError("Item not found.", "not_found");
      const result = inventory.useItem({ guildId, userId, itemId: item.id, config });
      return `Used **${result.item.name}**.`;
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
          return `${r.equipped ? "[E] " : ""}${item?.name ?? r.itemId} ×${r.quantity}`;
        })
        .join("\n");
    }
  }

  if (group === "jobs") {
    if (sub === "list") {
      const rows = jobs.listJobs(guildId, true);
      return rows.map((j) => `\`${j.key}\` ${j.name} — ${j.payMin}-${j.payMax}`).join("\n") || "No jobs configured.";
    }
    if (sub === "choose") {
      jobs.chooseJob(guildId, userId, i.options.getString("job", true), config);
      return "Job selected.";
    }
    if (sub === "work") {
      const result = jobs.doJobWork({
        guildId,
        userId,
        config,
      });
      quests.bumpProgress(guildId, userId, "job_work", 1, config);
      return `${result.flavor}\n${result.failed ? "Shift failed" : "Earned"} ${formatCurrency(Math.abs(result.paid), config, { currencyKey: result.currencyKey })}${result.paid < 0 ? " (fine)" : ""}.`;
    }
    if (sub === "resign") {
      jobs.resignJob(guildId, userId);
      return "You resigned from your job.";
    }
    if (sub === "progress") {
      const profile = money.ensureProfile(guildId, userId);
      return `Job: ${profile.jobKey ?? "none"} · Level ${profile.jobLevel} · ${profile.jobXp} XP`;
    }
  }

  if (group === "pets") {
    const petId = i.options.getInteger("pet") ?? 0;
    if (sub === "list") {
      const owned = pets.listOwnedPets(guildId, userId);
      return owned.map((p) => `#${p.id} **${p.name}** Lv${p.level}`).join("\n") || "You have no pets.";
    }
    if (sub === "adopt") {
      const pet = pets.adoptPet({
        guildId,
        userId,
        speciesKey: i.options.getString("species", true),
        name: i.options.getString("name") ?? undefined,
        config,
      });
      return `Adopted **${pet.pet.name}** (#${pet.pet.id}).`;
    }
    if (sub === "info") {
      const pet = pets.lazyTickPet(petId, guildId, config);
      return `**${pet.name}** (#${pet.id}) Lv${pet.level}\nHunger ${pet.hunger} · Energy ${pet.energy} · Happy ${pet.happiness}\nATK ${pet.atk} DEF ${pet.def} HP ${pet.hp} SPD ${pet.speed}`;
    }
    if (sub === "active") {
      pets.setActivePet(guildId, userId, petId);
      return `Active pet set to #${petId}.`;
    }
    if (sub === "feed") {
      pets.feedPet({ guildId, userId, petId, config });
      return "Pet fed.";
    }
    if (sub === "play") {
      pets.playWithPet({ guildId, userId, petId, config });
      return "You played with your pet.";
    }
    if (sub === "train") {
      pets.trainPet({ guildId, userId, petId, config });
      return "Training complete.";
    }
    if (sub === "adventure") {
      const result = pets.adventurePet({ guildId, userId, petId, config });
      return result.success
        ? `Adventure success! Earned ${formatCurrency(result.reward, config, { currencyKey: result.currencyKey })}.`
        : "Adventure failed — better luck next time.";
    }
    if (sub === "battle") {
      const result = pets.battlePets({
        guildId,
        challengerUserId: userId,
        challengerPetId: petId,
        opponentPetId: i.options.getInteger("opponent", true),
        config,
      });
      return `Battle ${result.challengerWon ? "won" : "lost"}! Winner pet #${result.winnerPetId} (${result.scoreA} vs ${result.scoreB}).`;
    }
    if (sub === "rename") {
      pets.renamePet(guildId, userId, petId, i.options.getString("name", true), config);
      return "Pet renamed.";
    }
    if (sub === "release") {
      pets.releasePet(guildId, userId, petId, config);
      return "Pet released.";
    }
  }

  if (group === "craft") {
    if (sub === "recipes") {
      return (
        crafting
          .listRecipes(guildId, true)
          .map((r) => `\`${r.key}\` ${r.name} (${r.durationSeconds}s)`)
          .join("\n") || "No recipes."
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
      return `Crafting started (#${entry.entry.id}). Ready <t:${Math.floor(entry.entry.completesAt.getTime() / 1000)}:R>.`;
    }
    if (sub === "queue") {
      const queue = crafting.listQueue(guildId, userId, true);
      return (
        queue
          .map(
            (q) =>
              `#${q.id} recipe ${q.recipeId} · ${q.cancelled ? "cancelled" : q.collected ? "collected" : q.completesAt.getTime() <= Date.now() ? "ready" : "cooking"}`,
          )
          .join("\n") || "Queue empty."
      );
    }
    if (sub === "collect") {
      crafting.collectCraft({ guildId, userId, craftId: i.options.getInteger("id", true), config });
      return "Craft collected.";
    }
    if (sub === "cancel") {
      crafting.cancelCraft({ guildId, userId, craftId: i.options.getInteger("id", true), config });
      return "Craft cancelled.";
    }
  }

  if (group === "quests") {
    if (sub === "list") {
      return (
        quests
          .listQuests(guildId, true)
          .map((q) => `\`${q.key}\` ${q.name} (${q.questType})`)
          .join("\n") || "No quests."
      );
    }
    if (sub === "progress") {
      const rows = quests.listQuestProgress(guildId, userId, config);
      return (
        rows
          .map((r) => `${r.quest.name}: ${r.progress.progress}/${r.quest.objectiveTarget}${r.progress.claimed ? " ✓" : ""}`)
          .join("\n") || "No progress yet."
      );
    }
    if (sub === "claim") {
      const result = quests.claimQuest({
        guildId,
        userId,
        questKey: i.options.getString("quest", true),
        config,
      });
      return `Claimed quest reward: ${formatCurrency(result.rewardAmount, config, { currencyKey: result.quest.rewardCurrencyKey })}.`;
    }
    if (sub === "achievements") {
      return (
        quests
          .listAchievements(guildId, true)
          .map((a) => `\`${a.key}\` ${a.name}`)
          .join("\n") || "No achievements."
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
            return `#${l.id} ${item?.name ?? "?"} ×${l.quantity} — ${formatCurrency(l.price, config, { currencyKey: l.currencyKey })}`;
          })
          .join("\n") || "No listings."
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
      return `Listed #${listing.listing.id}.`;
    }
    if (sub === "buy") {
      markets.buyMarketListing({
        guildId,
        buyerId: userId,
        listingId: i.options.getInteger("listing", true),
        config,
      });
      return "Purchase complete.";
    }
    if (sub === "cancel") {
      markets.cancelMarketListing({
        guildId,
        userId,
        listingId: i.options.getInteger("listing", true),
        config,
      });
      return "Listing cancelled.";
    }
  }

  if (group === "trade") {
    if (sub === "start") {
      const partner = i.options.getUser("user", true);
      const trade = markets.startTrade({
        guildId,
        initiatorId: userId,
        partnerId: partner.id,
        config,
      });
      return `Trade #${trade.id} started with ${partner}.`;
    }
    if (sub === "add") {
      const type = i.options.getString("type", true) as "currency" | "item";
      const itemKey = i.options.getString("item");
      const item = itemKey ? inventory.getItemByKey(guildId, itemKey) : null;
      markets.addTradeOffer({
        guildId,
        tradeId: i.options.getInteger("trade", true),
        userId,
        offerType: type,
        amount: type === "currency" ? i.options.getInteger("amount", true) : 0,
        currencyKey: currency,
        itemId: item?.id,
        quantity: type === "item" ? i.options.getInteger("amount", true) : 0,
        config,
      });
      return "Offer added.";
    }
    if (sub === "remove") {
      const offerId = i.options.getInteger("offer", true);
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
      return "Offer removed.";
    }
    if (sub === "review") {
      const review = markets.reviewTrade(i.options.getInteger("trade", true));
      return `Trade #${review.trade.id} status=${review.trade.status} rev=${review.trade.revision}\nOffers: ${review.offers.length}`;
    }
    if (sub === "confirm") {
      const tradeId = i.options.getInteger("trade", true);
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
      return result.completed ? "Trade completed." : "Confirmed. Waiting for partner.";
    }
    if (sub === "cancel") {
      markets.cancelTrade({
        guildId,
        tradeId: i.options.getInteger("trade", true),
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
            return `#${a.id} ${item?.name ?? "?"} bid ${a.currentBid || a.startingBid} ends <t:${Math.floor(a.endsAt.getTime() / 1000)}:R>`;
          })
          .join("\n") || "No auctions."
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
      return `Auction #${auction.id} created.`;
    }
    if (sub === "bid") {
      markets.bidOnAuction({
        guildId,
        auctionId: i.options.getInteger("auction", true),
        bidderId: userId,
        amount: i.options.getInteger("amount", true),
        config,
      });
      return "Bid placed.";
    }
    if (sub === "buyout") {
      markets.buyoutAuction({
        guildId,
        auctionId: i.options.getInteger("auction", true),
        buyerId: userId,
        config,
      });
      void logEconomy(ctx, "economy_auction", "Economy auction buyout", [
        `**Auction:** #${i.options.getInteger("auction", true)}`,
        `**Buyer:** <@${userId}>`,
      ], { guildId, actorId: userId });
      return "Buyout complete.";
    }
    if (sub === "cancel") {
      const auction = markets.getAuction(guildId, i.options.getInteger("auction", true));
      if (!auction || auction.sellerId !== userId) throw new EconomyError("Auction not found.", "not_found");
      if (auction.currentBidderId) throw new EconomyError("Cannot cancel after bids.", "invalid");
      markets.settleAuction(guildId, auction.id, config);
      return "Auction cancelled/settled.";
    }
    if (sub === "watch") {
      markets.watchAuction(guildId, i.options.getInteger("auction", true), userId);
      return "Watching auction.";
    }
  }

  if (group === "leaderboard") {
    if (sub === "season") {
      const active = seasons.getActiveSeason(guildId);
      if (!active) return "No active season.";
      const board = seasons.getSeasonLeaderboard(guildId, active.id, 10);
      return board.map((r, idx) => `${idx + 1}. <@${r.userId}> — ${r.score}`).join("\n") || "No scores.";
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
      return rows.map((r, idx) => `${idx + 1}. <@${r.userId}> — Lv${r.level} (${r.xp} XP)`).join("\n") || "Empty.";
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
      return rows.map((r, idx) => `${idx + 1}. <@${r.userId}> — ${r.count} pets`).join("\n") || "Empty.";
    }
    const primary = money.getPrimaryCurrencyKey(guildId, config);
    const board = money.leaderboardRichest(guildId, primary, 10);
    return board.map((r, idx) => `${idx + 1}. <@${r.userId}> — ${formatCurrency(Number(r.total), config, { currencyKey: primary })}`).join("\n") || "Empty.";
  }

  if (group === "season") {
    const active = seasons.getActiveSeason(guildId);
    if (!active) return "No active season.";
    if (sub === "info") {
      return `**${active.name}** (\`${active.key}\`)\n${active.description}\nEnds <t:${Math.floor(active.endsAt.getTime() / 1000)}:R>`;
    }
    if (sub === "rewards") {
      return `Rewards: ${active.rewardsJson}`;
    }
    if (sub === "progress") {
      const score = seasons.getUserSeasonScore(guildId, active.id, userId);
      return `Your score: ${score?.score ?? 0}${score?.claimed ? " (claimed)" : ""}`;
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
      return `Adjusted ${target}. ${formatBalances(bal, config, currency)}`;
    }
    if (sub === "freeze" || sub === "unfreeze") {
      const target = i.options.getUser("user", true);
      money.setAccountFrozen(guildId, target.id, sub === "freeze", i.options.getString("reason") ?? undefined);
      void logEconomy(ctx, "economy_freeze", sub === "freeze" ? "Economy freeze" : "Economy unfreeze", [
        `**Staff:** <@${userId}>`,
        `**Target:** ${target}`,
      ], { guildId, actorId: userId, targetId: target.id });
      return sub === "freeze" ? "Account frozen." : "Account unfrozen.";
    }
    if (sub === "inspect") {
      const target = i.options.getUser("user", true);
      const profile = money.ensureProfile(guildId, target.id);
      const primary = money.getPrimaryCurrencyKey(guildId, config);
      const bal = money.getAccount(guildId, target.id, primary);
      return `**${target.username}** (${target.id})\n${formatBalances(bal, config, primary)}\nFrozen=${profile.frozen} Job=${profile.jobKey ?? "none"} Lv${profile.level}`;
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
      return `Wiped economy data for ${target}.`;
    }
    if (sub === "pause" || sub === "resume") {
      money.setGuildPaused(guildId, sub === "pause");
      return sub === "pause" ? "Economy paused." : "Economy resumed.";
    }
    if (sub === "restock") {
      const n = inventory.restockDueListings(guildId);
      return `Restocked ${n} listings.`;
    }
    if (sub === "settle") {
      const n = markets.settleExpiredAuctions(guildId, config);
      return `Settled ${n} auctions.`;
    }
    if (sub === "seed") {
      inventory.seedDefaultCatalog(guildId);
      quests.seedDefaultQuests(guildId);
      return "Seeded default catalog and quests.";
    }
  }

  throw new EconomyError("Unknown subcommand.", "invalid");
}
