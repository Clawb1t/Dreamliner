import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelType, PermissionFlagsBits, PermissionsBitField, type GuildBasedChannel } from "discord.js";
import { memberCanReadChannel } from "./channelAccess.js";

const READ = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];

/** Just enough of a guild channel for the check: who's in the server, their permissions here,
 *  and (for threads) who's in the thread. */
function fakeChannel(options: {
  type?: ChannelType;
  members?: string[];
  permissions?: bigint[];
  threadMembers?: string[];
}): GuildBasedChannel {
  const members = new Map((options.members ?? ["user"]).map((id) => [id, { id }]));
  const threadMembers = new Set(options.threadMembers ?? []);
  return {
    type: options.type ?? ChannelType.GuildText,
    guild: {
      members: {
        cache: members,
        fetch: async (id: string) => {
          const member = members.get(id);
          if (!member) throw new Error("Unknown Member");
          return member;
        },
      },
    },
    permissionsFor: () => new PermissionsBitField(options.permissions ?? READ),
    members: {
      cache: new Map([...threadMembers].map((id) => [id, { id }])),
      fetch: async (id: string) => {
        if (!threadMembers.has(id)) throw new Error("Unknown Thread Member");
        return { id };
      },
    },
  } as unknown as GuildBasedChannel;
}

test("a member who can view the channel and read its history can read it", async () => {
  assert.equal(await memberCanReadChannel(fakeChannel({}), "user"), true);
});

test("no View Channel or no Read Message History means no", async () => {
  assert.equal(await memberCanReadChannel(fakeChannel({ permissions: [PermissionFlagsBits.ReadMessageHistory] }), "user"), false);
  assert.equal(await memberCanReadChannel(fakeChannel({ permissions: [PermissionFlagsBits.ViewChannel] }), "user"), false);
});

test("someone who isn't in the server can't read it", async () => {
  assert.equal(await memberCanReadChannel(fakeChannel({ members: ["someone_else"] }), "user"), false);
});

test("private threads need membership or Manage Threads", async () => {
  const thread = { type: ChannelType.PrivateThread };
  assert.equal(await memberCanReadChannel(fakeChannel({ ...thread }), "user"), false);
  assert.equal(await memberCanReadChannel(fakeChannel({ ...thread, threadMembers: ["user"] }), "user"), true);
  assert.equal(
    await memberCanReadChannel(fakeChannel({ ...thread, permissions: [...READ, PermissionFlagsBits.ManageThreads] }), "user"),
    true,
  );
});
