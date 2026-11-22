import type { ActionDef } from "./action.js";
import { blockActions } from "./actions/blocks.js";
import { channelActions } from "./actions/channels.js";
import { memberActions } from "./actions/members.js";
import { messageActions } from "./actions/messages.js";
import { pluginActions } from "./actions/plugins.js";
import { roleActions } from "./actions/roles.js";
import { utilityActions, variableActions } from "./actions/utilities.js";
import { schemaForFields } from "./fields.js";

export const ACTIONS: ActionDef[] = [
  ...messageActions,
  ...memberActions,
  ...channelActions,
  ...roleActions,
  ...blockActions,
  ...variableActions,
  ...pluginActions,
  ...utilityActions,
];

export const ACTION_MAP = new Map(ACTIONS.map((a) => [a.type, a]));

/** Strict schema per action type (fields + nested block keys), built once. */
export const ACTION_SCHEMAS = new Map(ACTIONS.map((a) => [a.type, schemaForFields(a.fields, a.extraSchema ?? {})]));

export const CATEGORIES: { key: ActionDef["category"]; label: string; description: string }[] = [
  { key: "messages", label: "Messages", description: "Reply, send, DM, react, threads" },
  { key: "members", label: "Members", description: "Roles, nicknames, time outs, voice" },
  { key: "channels", label: "Channels", description: "Create, edit, lock, invites" },
  { key: "roles", label: "Roles", description: "Create and edit roles" },
  { key: "logic", label: "Logic", description: "If, repeat, random, wait, stop" },
  { key: "variables", label: "Variables", description: "Remember values, maths, text" },
  { key: "interactions", label: "Buttons and forms", description: "Buttons, menus, pop-up forms" },
  { key: "plugins", label: "Dreamliner plugins", description: "Images, tags, giveaways, economy and more" },
  { key: "utilities", label: "Utilities", description: "Info, random picks, dice, polls, logs" },
];
