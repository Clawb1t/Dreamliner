import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Client } from "discord.js";

// Regression tests for cross-server authorization fixes. Isolated scratch DB, set before any getDb().
const scratchDir = mkdtempSync(join(tmpdir(), "dreamliner-security-test-"));
process.env.DATABASE_URL = `file:${join(scratchDir, "test.db")}`;

const { runMigrations } = await import("../scripts/migrate.js");
runMigrations();

const { getDb } = await import("../db/client.js");
const { fetchGuildChannel } = await import("./guildChannel.js");
const { neutralizeMentions } = await import("./templates.js");
const birthdays = await import("../plugins/birthdays/functions/store.js");
const money = await import("../plugins/economy/functions/money.js");
const { EXCHANGE_DAILY_GLOBAL_CAP } = await import("../plugins/economy/functions/format.js");
const suggestionStore = await import("../plugins/suggestions/functions/store.js");

after(() => {
  try {
    (getDb() as unknown as { session: { client: Database.Database } }).session.client.close();
  } catch {
    /* best effort */
  }
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* leftover temp dir is harmless */
  }
});

const GUILD_A = "100000000000000001";
const GUILD_B = "100000000000000002";

function fakeClient(channels: Record<string, { guildId: string }>): Client {
  const lookup = (id: string) => (channels[id] ? { id, ...channels[id] } : undefined);
  return {
    channels: {
      cache: { get: lookup },
      fetch: async (id: string) => {
        const channel = lookup(id);
        if (!channel) throw new Error("Unknown Channel");
        return channel;
      },
    },
  } as unknown as Client;
}

describe("fetchGuildChannel", () => {
  const client = fakeClient({
    "200000000000000001": { guildId: GUILD_A },
    "200000000000000002": { guildId: GUILD_B },
  });

  it("returns a channel only for its own server", async () => {
    assert.ok(await fetchGuildChannel(client, GUILD_A, "200000000000000001"));
    assert.equal(await fetchGuildChannel(client, GUILD_A, "200000000000000002"), null);
  });

  it("rejects missing, malformed and unknown ids", async () => {
    assert.equal(await fetchGuildChannel(client, GUILD_A, ""), null);
    assert.equal(await fetchGuildChannel(client, GUILD_A, "../../config"), null);
    assert.equal(await fetchGuildChannel(client, GUILD_A, "299999999999999999"), null);
    assert.equal(await fetchGuildChannel(client, null, "200000000000000001"), null);
  });
});

describe("birthdays set by staff", () => {
  const USER = "300000000000000001";

  it("only change the birthday in the server that set them", () => {
    birthdays.setBirthday(USER, { month: 3, day: 14, year: null }, "Europe/London");
    birthdays.setGuildBirthday(GUILD_A, USER, { month: 12, day: 25, year: null }, "staff");

    assert.deepEqual(birthdays.getBirthday(USER), { userId: USER, month: 3, day: 14, year: null, timezone: "Europe/London" });
    assert.equal(birthdays.getBirthdayIn(GUILD_A, USER)?.month, 12);
    assert.equal(birthdays.getBirthdayIn(GUILD_B, USER)?.month, 3);
    assert.equal(birthdays.getBirthdayIn(GUILD_A, USER)?.timezone, "Europe/London");
  });

  it("are removed without touching the member's own birthday", () => {
    assert.equal(birthdays.removeGuildBirthday(GUILD_A, USER), true);
    assert.equal(birthdays.getBirthdayIn(GUILD_A, USER)?.month, 3);
    assert.ok(birthdays.getBirthday(USER));
  });
});

describe("/exchange daily cap", () => {
  const USER = "400000000000000001";

  it("stops global coins from exchanges past the cap, across every server", () => {
    money.creditServer(GUILD_A, USER, 1_000_000);
    money.creditServer(GUILD_B, USER, 1_000_000);
    const perServer = (EXCHANGE_DAILY_GLOBAL_CAP / 0.1) * 0.6;
    money.exchangeServerForGlobal(GUILD_A, USER, perServer, 0.1);
    assert.throws(() => money.exchangeServerForGlobal(GUILD_B, USER, perServer, 0.1), money.ExchangeLimitError);
  });
});

describe("suggestion comments", () => {
  it("are only deleted through the suggestion they belong to", async () => {
    const comment = await suggestionStore.addComment({ suggestionId: 1, authorId: "u", content: "hi", anonymous: false });
    assert.equal(await suggestionStore.deleteComment(comment.id, 2), false);
    assert.equal(await suggestionStore.deleteComment(comment.id, 1), true);
  });
});

describe("neutralizeMentions", () => {
  it("keeps names from pinging anyone", () => {
    const out = neutralizeMentions("<@&123> <@456> <#789> @everyone @here");
    assert.ok(!/<[@#]/.test(out));
    assert.ok(!/@(everyone|here)/.test(out));
    assert.equal(neutralizeMentions("Plain name"), "Plain name");
  });
});
