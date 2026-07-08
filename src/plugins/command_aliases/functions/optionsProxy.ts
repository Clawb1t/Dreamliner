import type { ChatInputCommandInteraction, Client } from "discord.js";

type StoredOptions = Record<string, unknown>;

function readStored(name: string, stored: StoredOptions): unknown {
  if (Object.prototype.hasOwnProperty.call(stored, name)) return stored[name];
  return undefined;
}

function missingRequired(name: string): never {
  throw new Error(`Missing required alias option: ${name}`);
}

export function createStoredOnlyOptionsProxy(
  client: Client,
  stored: StoredOptions,
): ChatInputCommandInteraction["options"] {
  return {
    getSubcommand: (required?: boolean) => {
      const value = readStored("subcommand", stored);
      if (typeof value === "string") return value;
      return required ? missingRequired("subcommand") : null;
    },
    getSubcommandGroup: (required?: boolean) => {
      const value = readStored("subcommand_group", stored);
      if (typeof value === "string") return value;
      return required ? missingRequired("subcommand_group") : null;
    },
    getString: (name: string, required?: boolean) => {
      const value = readStored(name, stored);
      if (typeof value === "string") return value;
      return required ? missingRequired(name) : null;
    },
    getInteger: (name: string, required?: boolean) => {
      const value = readStored(name, stored);
      if (typeof value === "number") return value;
      return required ? missingRequired(name) : null;
    },
    getNumber: (name: string, required?: boolean) => {
      const value = readStored(name, stored);
      if (typeof value === "number") return value;
      return required ? missingRequired(name) : null;
    },
    getBoolean: (name: string, required?: boolean) => {
      const value = readStored(name, stored);
      if (typeof value === "boolean") return value;
      return required ? missingRequired(name) : null;
    },
    getUser: (name: string, required?: boolean) => {
      const value = readStored(name, stored);
      if (value && typeof value === "object" && "id" in value) {
        return client.users.cache.get(String((value as { id: string }).id)) ?? (required ? missingRequired(name) : null);
      }
      if (typeof value === "string") {
        return client.users.cache.get(value) ?? (required ? missingRequired(name) : null);
      }
      return required ? missingRequired(name) : null;
    },
    getChannel: () => null,
    getRole: () => null,
    getAttachment: () => null,
    getMentionable: () => null,
    get: (name: string, required?: boolean) => {
      const value = readStored(name, stored);
      if (value !== undefined) return value as ReturnType<ChatInputCommandInteraction["options"]["get"]>;
      return required ? missingRequired(name) : null;
    },
    data: [],
    resolved: undefined,
  } as unknown as ChatInputCommandInteraction["options"];
}

export function createStoredOptionsProxy(
  interaction: ChatInputCommandInteraction,
  stored: StoredOptions,
): ChatInputCommandInteraction["options"] {
  const base = interaction.options;

  return {
    getSubcommand: (required?: boolean) => {
      const value = readStored("subcommand", stored);
      if (typeof value === "string") return value;
      return required ? base.getSubcommand(true) : base.getSubcommand();
    },
    getSubcommandGroup: (required?: boolean) => {
      const value = readStored("subcommand_group", stored);
      if (typeof value === "string") return value;
      return required ? base.getSubcommandGroup(true) : base.getSubcommandGroup();
    },
    getString: (name: string, required?: boolean) => {
      const value = readStored(name, stored);
      if (typeof value === "string") return value;
      return required ? base.getString(name, true) : base.getString(name);
    },
    getInteger: (name: string, required?: boolean) => {
      const value = readStored(name, stored);
      if (typeof value === "number") return value;
      return required ? base.getInteger(name, true) : base.getInteger(name);
    },
    getNumber: (name: string, required?: boolean) => {
      const value = readStored(name, stored);
      if (typeof value === "number") return value;
      return required ? base.getNumber(name, true) : base.getNumber(name);
    },
    getBoolean: (name: string, required?: boolean) => {
      const value = readStored(name, stored);
      if (typeof value === "boolean") return value;
      return required ? base.getBoolean(name, true) : base.getBoolean(name);
    },
    getUser: (name: string, required?: boolean) => {
      const value = readStored(name, stored);
      if (value && typeof value === "object" && "id" in value) {
        return (
          interaction.client.users.cache.get(String((value as { id: string }).id)) ??
          (required ? base.getUser(name, true) : base.getUser(name))
        );
      }
      if (typeof value === "string") {
        return interaction.client.users.cache.get(value) ?? (required ? base.getUser(name, true) : base.getUser(name));
      }
      return required ? base.getUser(name, true) : base.getUser(name);
    },
    getChannel: (name: string, required?: boolean) => (required ? base.getChannel(name, true) : base.getChannel(name)),
    getRole: (name: string, required?: boolean) => (required ? base.getRole(name, true) : base.getRole(name)),
    getAttachment: (name: string, required?: boolean) =>
      required ? base.getAttachment(name, true) : base.getAttachment(name),
    getMentionable: (name: string, required?: boolean) =>
      required ? base.getMentionable(name, true) : base.getMentionable(name),
    get: (name: string, required?: boolean) => {
      const value = readStored(name, stored);
      if (value !== undefined) return value as ReturnType<typeof base.get>;
      return required ? base.get(name, true) : base.get(name);
    },
    data: base.data,
    resolved: base.resolved,
  } as ChatInputCommandInteraction["options"];
}

export function createAliasInteractionProxy(
  interaction: ChatInputCommandInteraction,
  stored: StoredOptions,
): ChatInputCommandInteraction {
  return new Proxy(interaction, {
    get(target, prop, receiver) {
      if (prop === "options") {
        return createStoredOptionsProxy(target, stored);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ChatInputCommandInteraction;
}
