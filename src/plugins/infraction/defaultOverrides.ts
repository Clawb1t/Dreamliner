import type { ConfigOverride } from "../../core/types.js";

export const infractionDefaultOverrides: ConfigOverride[] = [
  {
    level: ">=50",
    config: {
      can_warn: true,
      can_note: true,
      can_mute: true,
      can_kick: true,
      can_view: true,
      can_edit_reason: true,
      can_edit_duration: true,
    },
  },
  {
    level: ">=100",
    config: {
      can_ban: true,
      can_unban: true,
      can_softban: true,
      can_delete: true,
    },
  },
];
