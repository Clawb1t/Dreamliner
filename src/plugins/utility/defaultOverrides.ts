import type { ConfigOverride } from "../../core/types.js";

export const utilityDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_search: true,
      can_clean: true,
      can_userinfo: true,
      can_server: true,
      can_channelinfo: true,
      can_messageinfo: true,
      can_inviteinfo: true,
      can_roleinfo: true,
      can_emojiinfo: true,
      can_snowflake: true,
      can_roles: true,
      can_level: true,
      can_context: true,
      can_source: true,
      can_nickname: true,
      can_vcmove: true,
      can_vckick: true,
      can_help: true,
      can_avatar: true,
      can_jumbo: true,
      can_info: true,
      can_time: true,
    },
  },
  {
    level: ">=100",
    config: {
      can_reload_guild: true,
      can_ping: true,
      can_about: true,
    },
  },
];
