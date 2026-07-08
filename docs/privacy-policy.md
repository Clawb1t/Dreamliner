# Privacy Policy

**Last updated:** 8 July 2026

This Privacy Policy explains how **Dreamliner** ("we," "us," or the "Service") collects, uses, stores, and shares information when you invite the bot to a Discord server or use its features.

Dreamliner is a Discord bot. Discord is a separate service operated by Discord Inc. Their [Privacy Policy](https://discord.com/privacy) and [Terms](https://discord.com/terms) also apply.

By using Dreamliner, you agree to this Policy and our [Terms of Service](terms-of-service.md).

---

## 1. Who this applies to

This Policy covers:

- **Server owners and administrators** who invite Dreamliner or upload configuration
- **Moderators and members** in servers where Dreamliner is used
- Anyone who interacts with Dreamliner commands or features in those servers

If you are a server admin, you are responsible for informing your community that Dreamliner is present and may process member data according to this Policy and your server’s own rules.

---

## 2. Data controller

For the **hosted** Dreamliner bot instance described in our public invite and README, the Dreamliner operators act as the data controller for data stored to operate the Service for your server.

Discord remains the controller of data on Discord’s platform (messages in channels, account profiles, etc.).

---

## 3. Information we collect

### 3.1 From Discord (automatically)

When Dreamliner is in your server and has the required intents and permissions, it may process:

| Category | Examples |
|----------|----------|
| **Server identifiers** | Guild ID, channel IDs, role IDs, message IDs |
| **User identifiers** | Discord user IDs, roles a member has |
| **Profile / display data** | Usernames, nicknames, and related display fields needed for name history, logs, and embeds |
| **Message data** | Message content, attachments metadata/URLs, embeds, and edit/delete context (when Message Content intent and logging/moderation features apply) |
| **Voice data** | Voice channel membership for voice tools, companion channels, and related logs |
| **Reactions** | Emoji reactions for reaction roles and starboard |
| **Moderation events** | Bans, kicks, mutes, and similar Discord events the bot is configured to handle |
| **Interactions** | Slash command usage, button/select menu interactions, and command options you provide |

Dreamliner uses Discord’s **Message Content** privileged intent. That means the bot can receive message text in guild channels where it can see messages, not only slash-command input.

Dreamliner does **not** request Direct Message intents and does **not** listen for incoming DMs as a command interface. It may **send** outbound DMs (for example, moderation notices) when configured.

### 3.2 Configuration and staff-provided content

When administrators use `/config` and related commands, we store:

- Uploaded and effective YAML configuration (levels, plugin settings, channel/role IDs, templates, patterns)
- The Discord user ID of the person who last updated the config
- Plugin content such as tags, scheduled post text, welcome templates, censor rules, reminders, sticky ("persist") message content, custom events, and command aliases

### 3.3 Data we create or derive

Depending on enabled plugins, we may store:

- **Moderation cases** (type, reason, moderator/target IDs, timestamps, expiry, metadata)
- **Automod strike counts**
- **Message log cache** for edit/delete logging (author ID, username, channel name, content)
- **Message archives** from tools like `/clean` or `/source` (author tags, content, attachment URLs)
- **Aggregate stats** (message counts, joins/leaves; typically without full message bodies)
- **Username and nickname history**
- **Starboard** post references and star counts
- **Role panel** mappings and related message/role IDs
- **Companion channel** hub and ownership state
- **Counter** values and channel bindings

### 3.4 What we do not intentionally collect

- Payment or billing information (the hosted bot is free)
- Precise GPS/location data
- Government ID documents
- Analytics from third-party marketing/ad SDKs in the bot codebase

Operational process logs (for example, errors in our hosting environment) may incidentally include technical details needed to fix outages. They are not used to profile members.

---

## 4. How we use information

We use the information above to:

- Provide moderation, logging, roles, automation, stats, and other configured features
- Enforce permission levels and `can_*` flags from your config
- Send command replies, embeds, and optional moderation DMs
- Maintain case history, name history, and archives your staff rely on
- Keep the Service secure, reliable, and compliant with Discord’s developer policies
- Improve documentation and support when you contact us about an issue

We do **not** sell personal data. We do **not** use member message content for advertising.

---

## 5. Legal bases (where applicable)

Where laws such as the GDPR apply, we process data based on:

- **Legitimate interests** in operating a moderation bot for servers that invited us
- **Contractual necessity** to provide features administrators configured
- **Consent** where Discord or local law requires it for certain privileged data processing (administrators enabling Message Content-dependent features act within Discord’s framework for their server)
- **Legal obligation** when we must retain or disclose data required by law

---

## 6. Sharing and disclosure

We may share information with:

| Recipient | Why |
|-----------|-----|
| **Discord** | All bot traffic goes through Discord’s API; channel logs you configure are posted into Discord channels you choose |
| **Hosting / infrastructure providers** | To run the bot process and database |
| **Your server staff** | Via commands, embeds, and log channels they can access |
| **Authorities** | If required by law, valid legal process, or to protect safety and rights |

We do not sell or rent personal information to data brokers.

Content posted to Discord log channels is retained according to Discord and your channel settings, outside our database retention rules.

---

## 7. Retention

Retention depends on the feature and whether administrators delete data or remove the bot.

| Data | Typical retention |
|------|-------------------|
| **Message log cache** (`log_messages`) | About **42 days**, then pruned in the course of ordinary operation |
| **Guild configuration** | Until overwritten, deleted by operators, or the server is removed from our systems |
| **Moderation cases & strikes** | Kept until deleted by authorized commands/operators; expired actions may remain as inactive history |
| **Clean/source archives** | Kept until deleted by operators (no automatic short TTL) |
| **Name / username history** | Kept while the related plugins remain in use and records are not cleared |
| **Stats & counters** | Kept as aggregate history until cleared or removed |
| **Tags, reminders, panels, stickies, aliases, etc.** | Until removed by commands or operators |

We may retain limited records longer if needed for security investigations, dispute resolution, or legal compliance.

Removing Dreamliner from a Discord server stops new collection for that server but does **not** automatically erase all historical database records. Contact us to request deletion (see below).

---

## 8. Storage and security

Data for the hosted Service is stored in our operating environment (including a database used by the bot). We take reasonable technical and organizational measures appropriate to a free Discord bot service, but no system is perfectly secure.

You should:

- Limit who has high Dreamliner levels and Discord **Manage Server**
- Avoid putting secrets in YAML beyond necessary IDs and settings
- Use private log channels for sensitive moderation content

---

## 9. International transfers

We and our infrastructure providers may process data in countries other than where you or your members live. Where required, we rely on appropriate safeguards for such transfers.

---

## 10. Your rights and choices

Depending on your location, you may have rights to access, correct, delete, restrict, or object to certain processing, and to lodge a complaint with a supervisory authority.

**Practical options for Discord users:**

- Ask your **server administrators** to change Dreamliner settings, disable logging plugins, or remove the bot
- Use Discord’s own privacy tools and request flows for data Discord holds
- Contact the Dreamliner operators for deletion or access requests related to data we store in our database (we may need to verify you and coordinate with server ownership)

We may decline requests that are unlawful, excessively repetitive, or that would interfere with the rights of others (for example, wiping another person’s moderation case without proper authority).

---

## 11. Children’s privacy

Dreamliner is intended for Discord servers that already follow Discord’s age requirements. We do not knowingly target children under 13 (or the minimum age in your country). If you believe a minor’s data was collected improperly through Dreamliner, contact us and we will take appropriate steps.

---

## 12. Automated decision-making

Automod, censor, and similar features can automatically delete messages, apply strikes, or take other actions based on rules your administrators configure. These are server-configured enforcement tools, not credit scoring or similar profiling. Administrators control those rules.

---

## 13. Changes to this Policy

We may update this Privacy Policy from time to time. The "Last updated" date will change when we do. Continued use of Dreamliner after changes become effective constitutes acceptance of the revised Policy, except where applicable law requires additional notice or consent.

---

## 14. Contact

For privacy questions or data requests related to Dreamliner, open an issue on the [Dreamliner repository](https://github.com/Clawb1t/Dreamliner) or contact the operators through any support channel linked from the bot.

Related documents:

- [Terms of Service](terms-of-service.md)
- [Logs plugin](plugins/logs.md)
- [Getting started](getting-started.md)
