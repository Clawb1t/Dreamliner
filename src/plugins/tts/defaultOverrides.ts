import type { ConfigOverride } from "../../core/types.js";

export const ttsDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=0",
    config: {
      can_speak: true,
    },
  },
  {
    level: ">=50",
    config: {
      can_manage_channel: true,
      can_skip: true,
      can_blacklist: true,
    },
  },
];
