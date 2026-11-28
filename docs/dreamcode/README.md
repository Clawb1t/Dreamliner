# Custom Commands (v3)

Guild slash commands built on the dashboard like a shortcut: a command has typed **options**, **access rules**, **cooldowns / daily limits**, and an ordered list of **steps**. Steps are actions (reply, give a role, create a channel, random image...) or blocks with nested steps (If, Repeat, Random branch, Buttons, Menu, Form). Code: `src/plugins/dream_commands/` (`engine/` is the builder runtime).

## Limits
- 25 commands per server, 100 with Dreamliner One (Discord's guild limit is 100; Dreamliner registers no other guild commands). Commands over the cap stay saved but aren't registered (dashboard shows "over the limit").
- Per program: 120 steps, nesting depth 6, 64 KB JSON, 25 options.
- Per run: 50 executed steps, 25 s of work (waits excluded), 25 Discord API calls, 3 created channels/roles/threads, 3 DMs, 15 minutes of waiting in total. Repeat ≤ 10, for-each ≤ 25.
- Per server: 20 created channels/roles/threads per hour, 5 concurrent runs, 60 runs/minute; per user 10 runs/minute. 500 stored follow-ups, 100 paused runs.
- Buttons/menus work for 24 hours; forms for 30 minutes.

## Program format
`engine/types.ts` (copied to the site's `src/lib/customCommands.ts`). Steps: `{ id: "step3", type, label?, continueOnError?, disabled?, config }`. Validation is `engine/validate.ts` (strict zod per action, built from the field list in each action definition: unknown types and keys are rejected). Old version 2 programs (one reply) are converted by migration 0153 and, for anything still arriving in the old shape, by `engine/legacy.ts`.

## Variables
`{user}`, `{user.mention|id|name|display_name|avatar_url|bot|created_at|joined_at}`, `{server}`, `{server.name|id|icon_url|owner|owner_id|member_count|verification_level|boosts|joined_at}`, `{channel}`, `{channel.name|id|type}`, `{option.<name>}` (+ `.id`, `.mention`, `.name`; attachments `.url`), `{<stepId>.<output>}`, `{var.<name>}`, `{loop.item}`, `{loop.index}`, `{form.<id>}`, `{press.user.*}`, `{random:1-100}`, `{time}`, `{date}`, `{timestamp}`, `{timestamp:R}`, `{runs}`, `{command}`. Fallbacks: `{option.reason|No reason}`. Old `{mention}` became `{user.mention}`.

## Security model
| Protection | Where |
|---|---|
| Builder's perms, capped: the saver must hold every permission the steps need and outrank roles they give/edit; stored as `last_editor_id` and re-checked on every run (refused + flagged "needs re-saving" if lost) | `engine/permissions.ts` (`builderReport`), `bridge/dreamCommands.ts` (`checkSave`), `functions/run.ts` (`prepareBuilder`) |
| Dreamliner's own permissions and hierarchy | `botReport`, `runtime.ts` (`checkRoleManageable`, `checkMemberActionable`, `requireBotPermission`) |
| Builder's channel-level permissions for channel actions | `runtime.ts` (`checkBuilderChannelPermission`) |
| Moderation (kick, ban, unban, timeout, bulk delete) also needs the RUNNER's permission and hierarchy; targets only a user option | `runtime.ts` (`checkRunnerModerates`, `checkOptionTarget`), `validate.ts` |
| No foreign ids: picked ids checked against this guild on save and before each run; run-time ids (typed, options, variables) resolved only through this guild | `permissions.ts` (`checkGuildIds`), `runtime.ts` (`resolveMember/Role/Channel`) |
| Typed user ids refused; targets are a single variable (runner, option, step output) | `validate.ts` (`checkTargets`) |
| DMs only to the runner or a user option, ≤ 3 per run, never ping | `actions/messages.ts` |
| Delete channel only for channels created earlier in the same run | `actions/channels.ts`, `validate.ts` |
| No role deletion, mass ban/kick/prune, server settings, @everyone server-wide perms, web requests | not in the catalogue |
| Created roles: only perms the builder and bot have, never Administrator / Manage Server / Manage Roles / Ban / Kick / Webhooks / Mention Everyone | `actions/roles.ts` |
| Webhook names that impersonate Discord, Dreamliner or staff refused | `actions/messages.ts` |
| Mentions: `allowedMentions` empty by default; users/roles listed explicitly; role and @everyone pings need the builder's Mention Everyone | `message.ts`, `permissions.ts` |
| Person-provided values escaped (@everyone/@here, role/user mentions, markdown links), control/bidi chars stripped, links http(s) only, Discord length limits applied before sending | `vars.ts`, `message.ts` |
| Caps: steps, time, API calls, creations, waits, repeats, list sizes, string/var sizes, program size | `types.ts` `LIMITS`, `interpreter.ts`, `limits.ts` |
| "Matches" is a linear glob (`*`, `?`), never a user regex | `conditions.ts` |
| Restart-safe waits (DB queue polled every 5 s) and follow-ups (DB, TTL, guild-scoped lookup, stale after edits) | `state.ts`, `functions/run.ts` |
| Each step wrapped; Discord errors become friendly messages; a crash never escapes the handler | `interpreter.ts`, `runtime.ts` (`friendlyError`) |
| Registration: one debounced bulk PUT per guild, reserved names, cap | `functions/guildSlash.ts` |
| Anti-mint: no step creates coins; "Charge coins" only spends | `actions/plugins.ts`, test |
| Dashboard: Manage Server or `dream_commands.can_manage`; per-user bridge rate limits | `bridge/dreamCommands.ts`, `bridge/rateLimit.ts` |

## Bridge
`/bridge/guilds/:id/commands` with `?userId=`: `GET ''` list, `POST ''` create, `GET catalog`, `GET templates`, `POST validate` (dry run), `POST import`, `GET|PUT|DELETE c/:name`, `POST c/:name/duplicate`, `GET c/:name/runs`, `POST c/:name/test`, `GET c/:name/export`.

## Autopilot
`POST /bridge/guilds/:id/ai/command` (Manage Server, `ai` rate-limit bucket) builds a whole command from a description, or refines `current` ({ name, program }), in a short conversation (`core/ai/dreamCommand.ts`, runner in `bridge/webAi.ts`). The model answers in strict structured output: options, access, cooldowns and each step's id/type are typed (types limited to steps the member could save), a step's settings travel as `config_json` and nested lists as `children` (`b0`/`else`, `steps`, `r0`, `btn:<id>`, `opt:<id>`). Every draft runs `validateProgram`, `checkGuildIds` and `builderReport` against the requesting member, gets one automatic repair turn, then is refused with its issues. Nothing is saved: the dashboard loads the draft into the builder. Each generation costs one Autopilot use (`consumeAiGate`); clarifying questions before it are free, and failures are refunded.
