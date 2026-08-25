import { z } from "zod";

export const COUNTER_METRICS = ["members", "messages", "boosts", "custom"] as const;
export const COUNTER_DISPLAYS = ["message", "channel_name", "voice_name"] as const;

export const zCounterEntry = z.strictObject({
  enabled: z.boolean().default(true).describe("Turn this counter on or off without deleting it."),
  name: z
    .string()
    .max(80)
    .default("")
    .describe("Counter label. Shown in the dashboard and, for message display, in the embed."),
  metric: z
    .enum(COUNTER_METRICS)
    .default("members")
    .describe(
      "What this counter tracks. members/messages/boosts update automatically; custom is set from the dashboard.",
    ),
  display: z
    .enum(COUNTER_DISPLAYS)
    .default("message")
    .describe(
      "Where to show the count: an embed message, a text channel's name, or a voice channel's name.",
    ),
  channel_id: z
    .string()
    .min(1)
    .describe(
      "Channel to display the counter in. A text channel for message/channel_name display, a voice channel for voice_name display.",
    ),
  format: z
    .string()
    .max(100)
    .default("{value}")
    .describe(
      "Template for the displayed text. {value} is replaced with the formatted count. Used as the embed line for message display, or the channel name for channel_name/voice_name display.",
    ),
  refresh_minutes: z
    .number()
    .int()
    .min(5)
    .max(1440)
    .default(10)
    .describe(
      "Minimum minutes between channel renames for channel_name/voice_name display — Discord allows at most 2 renames per 10 minutes per channel, so the name lags behind the real count. Ignored for message display, which updates immediately.",
    ),
  value: z
    .number()
    .int()
    .min(0)
    .max(2_147_483_647)
    .default(0)
    .describe(
      "Current value. Kept in sync automatically for members/messages/boosts; set this directly for custom counters.",
    ),
});

export const zCountersConfig = z.strictObject({
  counters: z
    .array(zCounterEntry)
    .default([])
    .describe("Counters to display. Add one entry per counter."),
});

export type CounterMetric = (typeof COUNTER_METRICS)[number];
export type CounterDisplay = (typeof COUNTER_DISPLAYS)[number];
export type CounterEntry = z.infer<typeof zCounterEntry>;
export type CountersConfig = z.infer<typeof zCountersConfig>;
