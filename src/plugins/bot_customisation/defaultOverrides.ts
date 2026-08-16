import type { ConfigOverride } from "../../core/types.js";

export const botCustomisationDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_avatar: true,
      can_banner: true,
      can_nickname: true,
      can_bio: true,
      can_display_name: true,
    },
  },
];
