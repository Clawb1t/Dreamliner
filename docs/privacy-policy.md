# Privacy Policy

**Last updated:** 5 September 2026

This Privacy Policy explains, in detail, how **Dreamliner** ("we," "us," "our," or the "Service") collects, uses, stores, discloses, and protects information in connection with the Dreamliner Discord bot, the Dreamliner dashboard and website (**dreamliner.site**), and any related features (collectively, the "Service").

Dreamliner operates on and through Discord, a separate platform operated by Discord Inc. ("Discord"). Discord's own [Privacy Policy](https://discord.com/privacy) and [Terms of Service](https://discord.com/terms) govern your relationship with Discord and apply independently of this Policy. We do not control, and are not responsible for, Discord's own data practices.

By inviting Dreamliner to a server, using its commands or dashboard, visiting dreamliner.site, or otherwise interacting with the Service, you acknowledge that you have read and understood this Policy. If you do not agree with this Policy, do not use the Service. This Policy is incorporated into, and should be read together with, our [Terms of Service](terms-of-service.md).

---

## 1. Scope and who this applies to

This Policy applies to:

- **Server owners and administrators** who invite Dreamliner, configure it, subscribe to Dreamliner One, or manage its dashboard for a server
- **Moderators and staff** who are granted elevated permissions inside Dreamliner
- **Members** of any server where Dreamliner is present, whether or not they ever run a command
- **Visitors** to dreamliner.site, including anyone completing a Passport verification, viewing public stats pages, or browsing documentation
- Anyone who otherwise interacts with Dreamliner's commands, buttons, forms, or automated features

**If you administer a server, you are solely responsible** for making your community aware that Dreamliner is present, for informing them (where required by law) that their data may be processed as described here, and for configuring the Service consistently with your own community's rules and any legal obligations that apply to you as a server operator.

---

## 2. Data controller and our role

For the **hosted, public** instance of Dreamliner referenced in our invite link, README, and dreamliner.site, the Dreamliner operators act as the data controller (or "business"/"processor," depending on your jurisdiction's terminology) for data stored to operate the Service.

Discord independently controls data that lives on Discord's own platform and infrastructure (message storage at rest on Discord's servers, account profiles, Discord's own moderation and Trust & Safety systems, Discord's own AutoMod when Dreamliner syncs into it, and Discord's payment/billing systems for any monetized feature). We do not control, audit, or take responsibility for how Discord itself stores or processes that data.

Where we act only on instructions from a server's administrators (for example, storing configuration you upload, or running automated rules you defined), we may act as a processor/service provider for that data on the administrators' behalf, with the administrators acting as the controller for their own community's data-handling decisions.

---

## 3. Information we collect

### 3.1 From Discord, automatically, as part of normal operation

When Dreamliner is added to your server and granted the relevant intents and permissions, it may receive and process the following categories of data through Discord's API and gateway:

| Category | Examples |
|----------|----------|
| **Server identifiers** | Guild ID, channel IDs, category IDs, role IDs, message IDs, emoji/sticker IDs, webhook IDs |
| **User identifiers** | Discord user IDs, usernames, global display names, per-server nicknames, avatar and banner hashes/URLs, roles a member holds, join/leave timestamps, timeout state |
| **Message data** | Message content, attachment metadata and URLs (and, for Automod's Image Scanning rule, a one-way fingerprint of attached images; see 3.4), embed content, reactions, edit history, and delete events, wherever Message Content intent and a relevant feature (logging, automod, clean, tags, custom commands, etc.) is enabled and applicable |
| **Voice data** | Voice channel membership, mute/deafen/stream/video state, and related timestamps, for voice tools, companion channels, and voice logging |
| **Moderation and administrative events** | Bans, kicks, timeouts, role changes, channel/role/server updates, invite creation/deletion, and other Discord audit-log-visible events the bot is configured to observe or act on |
| **Interaction data** | Slash command names and the option values you supply, button/select-menu/modal submissions, and autocomplete queries |
| **Image and avatar fingerprints** | A one-way, non-reversible perceptual hash computed from message image attachments (Automod's Image Scanning rule) and from member avatars (Impersonation Detection); see 3.4 |
| **Identity change events** | Username, global display name, server nickname, and avatar changes, when Impersonation Detection is enabled |

Dreamliner uses Discord's **Message Content** privileged intent, meaning it can receive the text of messages sent in channels it can see, not only text supplied through slash commands. Dreamliner does **not** request or use Direct Message intents and does not treat incoming DMs as a command interface. Dreamliner may **send** outbound DMs (for example, moderation notices, warning/ban notifications, ticket updates, an Impersonation Detection alert, or a Passport reminder) where a feature is configured to do so and Discord permits the message to be delivered.

### 3.2 Configuration and staff-provided content

When administrators use the dashboard, `/config`, or related commands, we store:

- The server's effective and (where applicable) user-supplied configuration (permission levels, Dreamliner Roles and their `can_*` grants, plugin settings, channel/role IDs, message templates, filter patterns, and similar settings)
- The Discord user ID of whoever last updated a given piece of configuration, for accountability and troubleshooting
- Content staff author or upload through plugin features: custom tags, scheduled/automated post text, welcome message templates, custom filter words/phrases/regular expressions, reminders, sticky ("persist") message content, custom slash commands built with Dreamcode, ticket panel text, suggestion/review categories, and similar content

### 3.3 Data we create or derive while operating the Service

Depending on which plugins a server has enabled, we may create and store:

- **Moderation cases** (type, reason, moderator and target IDs, timestamps, expiry, and structured metadata about how the case was created)
- **Automod strike counts and hit history**
- **Message log cache** used for edit/delete logging (author ID, username, channel name, and message content, time-limited; see section 7)
- **Message archives** produced by tools like `/clean` or `/source` (author tags, message content, and attachment URLs, kept until an operator deletes them)
- **Aggregate activity statistics** (message counts, join/leave counts, voice minutes, and similar counters), typically without retaining full message bodies
- **Username and nickname change history**
- **Member identity snapshots** (a per-server nickname, role IDs, and any active timeout expiry, kept so those specific fields can be restored if a member is re-added after a false-positive kick/ban or a raid cleanup)
- **Starboard** message references and star/reaction counts
- **Role panel** message-to-role mappings
- **Companion voice channel** hub and per-channel ownership state
- **Counter** values and the channels they are bound to
- **Ticket** transcripts, category configuration, and claim/close history, where the Tickets plugin is enabled
- **Suggestion and review** submissions, votes, statuses, and moderator responses
- **Economy** balances, transaction history, and collectible card inventories, where the Economy plugin is enabled
- **Saved image collections** a member builds through the Anime plugin
- **Custom voice preferences** (a chosen TTS voice) tied to a Discord user ID, where TTS is used
- **Image and avatar fingerprints** (16-character perceptual hashes, see 3.4), never the underlying image
- **Impersonation Detection watchlist entries** (a label, optionally a real member's Discord user ID kept live-synced, or a manual name and/or avatar fingerprint for a persona with no real account)
- **Impersonation Detection alerts** (the flagged member's ID/username, which protected identity or watchlist entry it resembled, a name-similarity score and/or avatar fingerprint distance, what triggered the check, any automatic action taken, and staff resolution status)
- **Identity change history** (prior and new username/display name/nickname values, and avatar fingerprints, with timestamps) when Impersonation Detection is enabled, independent of whether a change ever matched anything
- **Native Discord AutoMod sync state**: when enabled, Automod mirrors certain rules (keyword/preset filters, mention-spam limits) into Discord's own AutoMod system for your server. Discord's own systems then also process and enforce on messages under Discord's own, separate moderation pipeline. See [Discord's Privacy Policy](https://discord.com/privacy) for how Discord handles that.

### 3.4 Image and avatar fingerprinting

Automod's **Image Scanning** rule and **Impersonation Detection** never store the images they check. When one of these features looks at an image attachment or an avatar, the bot:

1. Downloads the image from Discord's own CDN into memory,
2. Computes a 64-bit perceptual hash (a short fingerprint, e.g. `0080808000000000`, not reversible back into a picture),
3. Compares that fingerprint to others (a blocklist for Image Scanning, or a protected member/watchlist entry for Impersonation Detection),
4. Discards the downloaded image immediately. Only the resulting fingerprint is ever written to our database.

**Image Scanning's blocklist is shared across every server**, not scoped to the server that added an entry. It is a single, platform-wide list of known-scam-image fingerprints (and the label a Dreamliner operator gave each one) maintained only by Dreamliner operators. Server administrators cannot add to it. See also section 6.

Impersonation Detection's watchlist and identity comparisons are scoped to the individual server that configured them.

### 3.5 The Dreamliner dashboard and website (dreamliner.site)

When you sign in to the dashboard, we use Discord's OAuth2 login flow to receive your Discord user ID, username, avatar, and the list of servers you belong to (so we can show you servers you can manage). We do not request or receive your Discord password, email address, or payment methods through this flow.

The dashboard uses a session cookie to keep you signed in. This is functionally necessary for the dashboard to work and is not used for cross-site advertising tracking.

Like essentially any web server, dreamliner.site's infrastructure incidentally logs standard request metadata (IP address, user agent, timestamps, and requested paths) for security, abuse prevention, and troubleshooting. These operational logs are not used to build advertising profiles.

### 3.6 Passport (member verification)

Where a server enables the Passport plugin, a joining member is directed to a public Passport page on dreamliner.site. Completing it involves:

- Signing in with Discord (the same OAuth2 flow described in 3.5), so we can confirm which Discord account is verifying
- Completing an in-house, self-hosted image captcha (no third-party captcha widget, and nothing loaded from another domain for this step)
- Standard web request metadata (see 3.5), including an IP address, associated with that verification attempt for anti-abuse purposes

The result (pass/fail, and which roles were subsequently granted) is sent back to the bot and logged as a `passport_verify` or `passport_kick` event as described in section 3.3.

### 3.7 Dreamliner One (premium subscriptions) and payments

Dreamliner One is a **per-server subscription** sold and billed entirely through **Discord's own monetization system** (a Discord "SKU"). **We do not process, receive, or store your payment card number, billing address, or any other payment instrument.** Discord is the payment processor and merchant of record for these subscriptions; Discord's own Privacy Policy and billing terms govern that transaction. We only receive a subscription **status** (active/inactive, and which server it applies to) from Discord's API, which we use to enable or disable premium-gated features for that server.

Billing questions, invoices, refunds, and payment disputes must be directed to Discord, not to us; see section 10 of the [Terms of Service](terms-of-service.md).

### 3.8 Custom bot branding submissions (human review)

Where a Dreamliner One server submits a custom bot avatar, banner, or display name style through the Custom Branding feature, the submitted image is queued and **reviewed by a human Dreamliner operator** before it is applied, to screen for NSFW content, hateful or extremist imagery, impersonation of real people or brands, and other policy violations. Submitted images are retained for as long as necessary to complete that review and to keep a record of what was approved or rejected, and may be viewed by Dreamliner operators performing that review.

### 3.9 Third-party services our features call out to

A small number of features send limited, feature-specific data to third-party APIs in order to work. We do not send your full message history, full member list, or unrelated personal data to any of these services, only what a given request needs:

| Feature | Third party | What is sent |
|---|---|---|
| **Translation** (`/translate`, auto-translate) | Google Translate (via an unofficial public API wrapper) | The specific text you asked to translate, or a message flagged for auto-translate; no Discord user ID or other identifying metadata is included in the translation request itself |
| **Social Notifications** (YouTube uploads) | YouTube Data API v3 (Google) | The creator handle/channel URL your server configured, so we can poll for new public uploads; we do not send viewer or member data to YouTube |
| **Anime** (`/anime neko`) | Nekos.best (a public, third-party anime-image API) | An anonymous image request; no Discord identifiers are sent |
| **Text-to-speech** (`/tts`) | None. Voice synthesis runs locally on our own infrastructure via the open-source Piper engine. Message text used for speech is **not** sent to any third-party voice/AI provider. | N/A |

Each third party's own privacy policy governs how it separately handles any data sent to it; we encourage you to review Google's privacy policy if your server uses translation or social notifications.

### 3.10 What we do not intentionally collect

- Full payment or billing information (see 3.7; Discord alone handles this)
- Precise GPS/location data
- Government ID documents
- Biometric identifiers (image and avatar "fingerprints," described in 3.4, are simple perceptual hashes for similarity matching, not biometric identification, and are not derived from or usable to identify a person's face or body)
- Analytics from third-party marketing/advertising SDKs embedded in the bot or dashboard codebase

Operational process logs (for example, application errors in our hosting environment) may incidentally include technical details needed to diagnose outages. They are not used to profile members.

---

## 4. How we use information

We use the information described above to:

- Provide moderation, logging, automation, role management, verification, engagement, and other features you or your administrators enable
- Enforce Dreamliner Roles, permission levels, and `can_*` flags configured for your server
- Detect, log, and (where configured) automatically act on rule violations, scam content, and impersonation attempts
- Send command replies, embeds, DMs, and website pages requested by your interactions
- Maintain moderation case history, identity history, and archives your staff rely on for ongoing server operations
- Process and administer Dreamliner One subscriptions (limited to subscription status; see 3.7)
- Operate, secure, debug, and improve the Service, including diagnosing outages and abuse
- Communicate with you about the Service, including changes to these policies, where appropriate
- Comply with legal obligations and enforce our [Terms of Service](terms-of-service.md)

**We do not sell personal data.** We do not use member message content for advertising, and we do not build cross-service advertising profiles from Service data.

---

## 5. Legal bases for processing (where applicable, e.g. GDPR/UK GDPR)

Where laws such as the EU/UK GDPR apply, we rely on one or more of the following legal bases:

- **Legitimate interests** in operating, securing, and improving a moderation and community-management bot for servers that invited it, including detecting abuse, scams, and impersonation
- **Contractual necessity** to provide the specific features an administrator has configured and to administer a Dreamliner One subscription
- **Consent**, where Discord's own framework or local law requires it for certain privileged data processing (for example, an administrator's decision to enable Message Content–dependent features, or a member's choice to use a feature that sends data to a third party under 3.9)
- **Legal obligation**, where we must retain, disclose, or delete data as required by applicable law or a valid legal process

---

## 6. Sharing and disclosure

We may share information with the following categories of recipients, and for the reasons stated:

| Recipient | Why |
|-----------|-----|
| **Discord** | All bot traffic and dashboard sign-in flows go through Discord's API; channel logs you configure are posted into Discord channels you choose; Discord alone processes Dreamliner One billing |
| **Every server running Automod's Image Scanning rule** | The scam-image fingerprint blocklist (see 3.4) is a single platform-wide list, not scoped to one server; adding an entry makes that fingerprint (never the image itself) checked against in every server with the rule enabled |
| **Third-party APIs described in 3.9** | Only the specific, feature-scoped data described there (translation text, a configured YouTube channel handle, or an anonymous image request), and only when that specific feature is used |
| **Hosting and infrastructure providers** | To run the bot process, database, and website that make up the Service |
| **Your own server staff** | Via commands, embeds, dashboard access, and log channels they are permitted to view |
| **Successors** | If the Service, or substantially all of its assets, is transferred (for example, through a merger, acquisition, or sale), information may be transferred as part of that transaction, subject to this Policy or a materially similar one |
| **Authorities** | Where required by law, valid legal process, or a good-faith belief that disclosure is necessary to protect the rights, property, or safety of Dreamliner, our users, Discord, or the public |

We do not sell or rent personal information to data brokers, and we do not disclose personal information to third parties for their own independent marketing purposes.

Content posted to Discord log channels or archived by tools such as `/clean`/`/source` is, once posted to Discord, also subject to Discord's own retention and access rules for that channel, independent of our own database retention practices described below.

---

## 7. Retention

Retention depends on the feature involved and on whether administrators or members actively delete data or remove the bot. As a general policy, we keep data only for as long as it serves the purpose it was collected for, subject to the following:

| Data | Typical retention |
|------|-------------------|
| **Message log cache** (`log_messages`) | About **42 days**, then pruned in the course of ordinary operation |
| **Guild configuration** | Until overwritten, deleted by operators, or the server is removed from our systems |
| **Moderation cases & strikes** | Kept until deleted by authorized commands/operators; expired actions may remain as inactive history |
| **Clean/source archives** | Kept until deleted by operators (no automatic short TTL) |
| **Name / username history** | Kept while the related plugins remain in use and records are not cleared |
| **Member identity snapshots** | Kept while Member Identity is in use (latest snapshot per member per server) until overwritten or deleted |
| **Stats & counters** | Kept as aggregate history until cleared or removed |
| **Tags, reminders, panels, stickies, aliases, tickets, suggestions, reviews, economy records, etc.** | Until removed by commands or operators |
| **Image Scanning blocklist fingerprints** | Platform-wide, not per-server; kept until removed by a Dreamliner operator |
| **Impersonation Detection watchlist, alerts, and identity history** | Kept while the plugin remains enabled for that server and records are not cleared by staff/operators |
| **Passport verification/session data** | Kept only as long as needed to complete verification and for a limited anti-abuse window afterward |
| **Custom branding submissions under human review** | Kept for as long as needed to review, apply, or reject the submission, and to retain a record of that decision |
| **Dreamliner One subscription status** | Mirrors Discord's own subscription record; we do not separately retain historical billing data of our own |

We may retain limited records for a longer period where necessary for security investigations, dispute resolution, or legal compliance, even if that exceeds the typical periods above.

Removing Dreamliner from a Discord server stops new collection for that server but does **not** automatically erase all historical database records for that server. Contact us to request deletion (see section 15).

---

## 8. Storage and security

Data for the Service is stored in our operating environment, including a database used by the bot process and the dashboard's own infrastructure. We take technical and organizational measures we consider reasonable and appropriate for a free, community-operated Discord bot, including restricting production access, using a shared-secret-authenticated bridge between the bot and the dashboard, and applying least-privilege patterns in our own code.

**No system is perfectly secure, and we cannot and do not guarantee that unauthorized access, disclosure, alteration, or destruction of data will never occur.** You use the Service, and provide any information to it, at your own risk. You should independently:

- Limit who has high Dreamliner Roles/levels and Discord's own **Manage Server**/**Administrator** permissions
- Avoid putting secrets or sensitive personal data in configuration, custom commands, tags, or logs beyond what is necessary
- Use private, restricted-access log channels for sensitive moderation content
- Promptly report any suspected security issue to us (see section 15)

---

## 9. International data transfers

Dreamliner, its infrastructure providers, and the third parties described in section 3.9 may process data in countries other than the one you or your members reside in, including the United States and other jurisdictions where our infrastructure or those third parties operate. Where applicable law requires a specific transfer mechanism (such as the EU Standard Contractual Clauses), we rely on appropriate safeguards for such transfers to the extent required.

By using the Service, you acknowledge and consent to this international processing of information as described in this Policy.

---

## 10. Your rights and choices

Depending on your location, you may have rights to access, correct, delete, restrict, port, or object to certain processing of your personal data, and to withdraw consent or lodge a complaint with a supervisory or consumer-protection authority.

**Practical options for Discord users:**

- Ask your **server administrators** to change Dreamliner's settings for your server, disable specific plugins (including logging, Automod, or Impersonation Detection), remove specific records, or remove the bot entirely
- Use Discord's own privacy tools and request flows for data Discord itself holds (message content on Discord's servers, your Discord account profile, etc.)
- Contact the Dreamliner operators (section 15) for deletion or access requests concerning data we store ourselves. We may need to verify your identity and, where the data belongs to a server rather than to you individually, coordinate with that server's ownership before acting

We may decline or limit requests that are unlawful, manifestly unfounded or excessive, technically infeasible, or that would unreasonably interfere with the rights of others (for example, a request to erase another member's moderation case history without proper authority over that server, or a request that would compromise an active investigation into abuse).

---

## 11. Children's privacy

Dreamliner is intended for use on Discord servers that already comply with Discord's own minimum age requirements. **The Service is not directed at children, and we do not knowingly collect personal information from anyone under the age required by Discord's Terms of Service or applicable local law (generally 13, and higher in some jurisdictions).** If you believe a minor's data was collected through Dreamliner in violation of this section, contact us using the details in section 15 and we will investigate and take appropriate action, which may include deleting the data in question.

---

## 12. Automated decision-making and profiling

Automod, Impersonation Detection, censor-style filters, and similar features can automatically delete messages, apply strikes, time out, kick, or ban a member, or take other configured enforcement action, based entirely on rules a server's own administrators chose to configure. This includes:

- Automod's **Image Scanning** rule (comparing an image's fingerprint to the blocklist described in 3.4)
- **Impersonation Detection** (comparing a member's name and/or avatar to a protected role holder or watchlist entry)

Both can be configured to act automatically (timeout, kick, or ban) without a staff member reviewing the match first, if an administrator chooses that setting. **These are server-configured enforcement tools, not credit-scoring, employment-screening, or similarly regulated automated decision-making, and they do not evaluate anything about a person beyond the specific, narrow signal each feature is designed to compare (message content against configured filters; an image's or avatar's fingerprint against a blocklist or protected identity).** Administrators control whether automatic action is used at all, and can switch any of these features to a staff-reviewed alert queue instead of an automatic action.

Where administrators enable **native Discord AutoMod sync**, certain rules are additionally mirrored into Discord's own AutoMod system, which independently processes and enforces on messages under Discord's own, separate moderation pipeline; see [Discord's Privacy Policy](https://discord.com/privacy) for how Discord handles that layer.

Given the nature of automated content matching, **false positives and false negatives are possible and expected**; no automated feature described in this Policy is guaranteed to be perfectly accurate. See also section 8 ("Automated moderation and detection features") of our [Terms of Service](terms-of-service.md).

---

## 13. Do Not Track and similar signals

Because the dashboard does not engage in third-party behavioral advertising tracking, it does not currently respond differently to browser "Do Not Track" signals or the Global Privacy Control. If our practices change such that this becomes relevant, we will update this Policy.

---

## 14. Changes to this Policy

We may update this Privacy Policy at any time, in our sole discretion, to reflect changes in the Service, our practices, or legal requirements. The "Last updated" date at the top will change when we do. Where a change is material, we will make reasonable efforts to provide notice (for example, through the documentation site, a changelog, or an announcement channel), but **your continued use of the Service after a change becomes effective constitutes your acceptance of the revised Policy**, except where applicable law requires additional notice or affirmative consent, in which case we will seek that consent as required.

---

## 15. Contact and data requests

For privacy questions, security reports, or data access/deletion requests related to Dreamliner, open an issue on the [Dreamliner repository](https://github.com/Clawb1t/Dreamliner) or contact the operators through any support channel linked from the bot or from dreamliner.site.

We will make reasonable efforts to respond to legitimate requests within a reasonable time, but this Policy does not create a specific guaranteed response time, except where required by applicable law.

Related documents:

- [Terms of Service](terms-of-service.md)
- [Logs plugin](plugins/logs.md)
- [Automod plugin](plugins/automod.md) (Image Scanning, native Discord AutoMod sync)
- [Impersonation Detection plugin](plugins/impersonation.md)
- [Passport plugin](plugins/passport.md)
- [Translation plugin](plugins/translation.md)
- [Getting started](getting-started.md)
