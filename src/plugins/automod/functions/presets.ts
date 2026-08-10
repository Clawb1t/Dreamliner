import {
  AUTOMOD_RULE_IDS,
  type AutomodConfig,
  type AutomodPresetName,
  type AutomodRuleConfig,
  type AutomodRuleId,
  type AutomodSensitivity,
} from "../../../config/schemas/automod.js";

function ladder(
  steps: Array<{ after: number; types: Array<"delete" | "warn" | "mute" | "kick" | "softban" | "ban" | "note">; duration_ms?: number }>,
): AutomodRuleConfig["ladder"] {
  return steps.map((step) => ({
    after: step.after,
    actions: step.types.map((type) => ({
      type,
      ...(step.duration_ms && (type === "mute" || type === "ban")
        ? { duration_ms: step.duration_ms }
        : type === "mute"
          ? { duration_ms: 600_000 }
          : {}),
    })),
  }));
}

function rule(
  enabled: boolean,
  sensitivity: AutomodSensitivity,
  strikeWindowMs: number,
  steps: AutomodRuleConfig["ladder"],
  settings: Record<string, unknown> = {},
): AutomodRuleConfig {
  return {
    enabled,
    sensitivity,
    strike_window_ms: strikeWindowMs,
    delete_message: true,
    points: 1,
    notify: false,
    ignored_channels: [],
    ignored_roles: [],
    ladder: steps,
    settings,
  };
}

function emptyRules(): Record<string, AutomodRuleConfig> {
  const out: Record<string, AutomodRuleConfig> = {};
  for (const id of AUTOMOD_RULE_IDS) {
    out[id] = rule(false, "balanced", 3_600_000, ladder([{ after: 1, types: ["delete"] }]));
  }
  return out;
}

export function buildPresetRules(preset: AutomodPresetName): Record<string, AutomodRuleConfig> {
  const rules = emptyRules();
  const hour = 3_600_000;
  const day = 86_400_000;

  const enable = (id: AutomodRuleId, cfg: AutomodRuleConfig) => {
    rules[id] = cfg;
  };

  if (preset === "light") {
    enable("slurs", rule(true, "balanced", day, ladder([{ after: 1, types: ["delete", "warn"] }])));
    enable("spam", rule(true, "lenient", hour, ladder([{ after: 1, types: ["delete"] }, { after: 3, types: ["warn"] }])));
    enable("duplicate", rule(true, "lenient", hour, ladder([{ after: 1, types: ["delete"] }])));
    enable("mass_mentions", rule(true, "lenient", hour, ladder([{ after: 1, types: ["delete", "warn"] }])));
    enable("everyone_here", rule(true, "balanced", day, ladder([{ after: 1, types: ["delete", "warn"] }])));
    enable(
      "raid",
      rule(true, "lenient", hour, ladder([{ after: 1, types: ["note"] }]), {
        join_count: 15,
        join_window_ms: 30_000,
      }),
    );
    return rules;
  }

  if (preset === "strict") {
    enable("profanity", rule(true, "strict", day, ladder([{ after: 1, types: ["delete"] }, { after: 2, types: ["warn"] }, { after: 4, types: ["mute"], duration_ms: 1_800_000 }])));
    enable("slurs", rule(true, "strict", day, ladder([{ after: 1, types: ["delete", "warn"] }, { after: 2, types: ["mute"], duration_ms: 3_600_000 }, { after: 3, types: ["softban"] }])));
    enable("excessive_swearing", rule(true, "strict", hour, ladder([{ after: 1, types: ["delete", "warn"] }, { after: 2, types: ["mute"], duration_ms: 1_800_000 }])));
    enable("custom_filter", rule(true, "balanced", day, ladder([{ after: 1, types: ["delete"] }, { after: 2, types: ["warn"] }])));
    enable("spam", rule(true, "strict", hour, ladder([{ after: 1, types: ["delete"] }, { after: 2, types: ["warn"] }, { after: 4, types: ["mute"], duration_ms: 600_000 }])));
    enable("emoji_spam", rule(true, "strict", hour, ladder([{ after: 1, types: ["delete"] }, { after: 3, types: ["mute"], duration_ms: 600_000 }])));
    enable("duplicate", rule(true, "strict", hour, ladder([{ after: 1, types: ["delete"] }, { after: 3, types: ["mute"], duration_ms: 600_000 }])));
    enable("copypasta", rule(true, "strict", hour, ladder([{ after: 1, types: ["delete"] }, { after: 2, types: ["warn"] }])));
    enable("sticker_gif_spam", rule(true, "strict", hour, ladder([{ after: 1, types: ["delete"] }, { after: 3, types: ["mute"], duration_ms: 600_000 }])));
    enable("attachment_spam", rule(true, "strict", hour, ladder([{ after: 1, types: ["delete"] }, { after: 3, types: ["warn"] }])));
    enable("newline_spam", rule(true, "strict", hour, ladder([{ after: 1, types: ["delete"] }])));
    enable("wall_of_text", rule(true, "strict", hour, ladder([{ after: 1, types: ["delete"] }])));
    enable("repeated_chars", rule(true, "strict", hour, ladder([{ after: 1, types: ["delete"] }])));
    enable("mass_mentions", rule(true, "strict", day, ladder([{ after: 1, types: ["delete", "warn"] }, { after: 2, types: ["mute"], duration_ms: 3_600_000 }])));
    enable("everyone_here", rule(true, "strict", day, ladder([{ after: 1, types: ["delete", "warn"] }, { after: 2, types: ["mute"], duration_ms: 3_600_000 }])));
    enable("invites", rule(true, "strict", day, ladder([{ after: 1, types: ["delete", "warn"] }, { after: 3, types: ["kick"] }])));
    enable("links", rule(true, "strict", hour, ladder([{ after: 1, types: ["delete"] }, { after: 3, types: ["warn"] }])));
    enable("excessive_caps", rule(true, "strict", hour, ladder([{ after: 1, types: ["delete"] }, { after: 3, types: ["warn"] }, { after: 5, types: ["mute"], duration_ms: 600_000 }])));
    enable("zalgo", rule(true, "strict", hour, ladder([{ after: 1, types: ["delete"] }])));
    enable(
      "raid",
      rule(true, "strict", hour, ladder([{ after: 1, types: ["note"] }]), {
        join_count: 6,
        join_window_ms: 20_000,
      }),
    );
    return rules;
  }

  // standard
  enable("profanity", rule(true, "balanced", day, ladder([{ after: 1, types: ["delete"] }, { after: 3, types: ["warn"] }, { after: 5, types: ["mute"], duration_ms: 600_000 }])));
  enable("slurs", rule(true, "balanced", day, ladder([{ after: 1, types: ["delete", "warn"] }, { after: 2, types: ["mute"], duration_ms: 1_800_000 }, { after: 4, types: ["softban"] }])));
  enable("excessive_swearing", rule(true, "balanced", hour, ladder([{ after: 1, types: ["delete"] }, { after: 2, types: ["warn"] }])));
  enable("custom_filter", rule(false, "balanced", day, ladder([{ after: 1, types: ["delete"] }, { after: 2, types: ["warn"] }])));
  enable("spam", rule(true, "balanced", hour, ladder([{ after: 1, types: ["delete"] }, { after: 3, types: ["warn"] }, { after: 5, types: ["mute"], duration_ms: 600_000 }])));
  enable("emoji_spam", rule(true, "balanced", hour, ladder([{ after: 1, types: ["delete"] }, { after: 3, types: ["warn"] }])));
  enable("duplicate", rule(true, "balanced", hour, ladder([{ after: 1, types: ["delete"] }, { after: 3, types: ["warn"] }])));
  enable("copypasta", rule(true, "balanced", hour, ladder([{ after: 1, types: ["delete"] }, { after: 3, types: ["warn"] }])));
  enable("sticker_gif_spam", rule(true, "balanced", hour, ladder([{ after: 1, types: ["delete"] }, { after: 3, types: ["warn"] }])));
  enable("attachment_spam", rule(true, "balanced", hour, ladder([{ after: 1, types: ["delete"] }, { after: 3, types: ["warn"] }])));
  enable("newline_spam", rule(true, "balanced", hour, ladder([{ after: 1, types: ["delete"] }])));
  enable("wall_of_text", rule(true, "balanced", hour, ladder([{ after: 1, types: ["delete"] }])));
  enable("repeated_chars", rule(true, "balanced", hour, ladder([{ after: 1, types: ["delete"] }])));
  enable("mass_mentions", rule(true, "balanced", day, ladder([{ after: 1, types: ["delete", "warn"] }, { after: 3, types: ["mute"], duration_ms: 1_800_000 }])));
  enable("everyone_here", rule(true, "balanced", day, ladder([{ after: 1, types: ["delete", "warn"] }])));
  enable("invites", rule(true, "balanced", day, ladder([{ after: 1, types: ["delete"] }, { after: 2, types: ["warn"] }])));
  enable("links", rule(true, "balanced", hour, ladder([{ after: 1, types: ["delete"] }, { after: 4, types: ["warn"] }])));
  enable("excessive_caps", rule(true, "balanced", hour, ladder([{ after: 1, types: ["delete"] }, { after: 3, types: ["warn"] }])));
  enable("zalgo", rule(true, "balanced", hour, ladder([{ after: 1, types: ["delete"] }])));
  enable(
    "raid",
    rule(true, "balanced", hour, ladder([{ after: 1, types: ["note"] }]), {
      join_count: 10,
      join_window_ms: 30_000,
    }),
  );
  return rules;
}

export function applyPresetToConfig(config: AutomodConfig, preset: AutomodPresetName): AutomodConfig {
  return {
    ...config,
    presets_applied: preset,
    rules: {
      ...config.rules,
      ...buildPresetRules(preset),
      // preserve custom filter entries when re-applying presets
      custom_filter: {
        ...buildPresetRules(preset).custom_filter!,
        enabled: config.rules.custom_filter?.enabled ?? false,
        settings: {
          ...buildPresetRules(preset).custom_filter!.settings,
          entries: Array.isArray(config.rules.custom_filter?.settings?.entries)
            ? config.rules.custom_filter!.settings.entries
            : [],
        },
      },
    },
  };
}

export function defaultAutomodRules(): Record<string, AutomodRuleConfig> {
  return emptyRules();
}
