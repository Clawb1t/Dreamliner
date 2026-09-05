# Terms of Service

**Last updated:** 5 September 2026

These Terms of Service (the "Terms") are a binding legal agreement between you and the operators of **Dreamliner** ("we," "us," "our," or the "Dreamliner operators") governing your access to and use of the Dreamliner Discord bot, the Dreamliner dashboard and website at dreamliner.site, and any related features, documentation, or services (collectively, the "Service").

**By inviting Dreamliner to a Discord server, signing in to the dashboard, configuring the Service, subscribing to Dreamliner One, or otherwise using any part of the Service, you accept and agree to be bound by these Terms and by our [Privacy Policy](privacy-policy.md), which is incorporated into these Terms by reference.**

If you do not agree to every part of these Terms, you must not invite, configure, subscribe to, or otherwise use the Service, and you should remove Dreamliner from any server where it is present.

---

## 1. The Service

Dreamliner is a hosted, third-party Discord bot and companion website that provides moderation, automated content and identity screening, role management, logging, engagement, scheduling, and related server-operations tooling for Discord servers (the "Service"). Server settings are managed primarily through a web dashboard, and additionally through YAML configuration and slash commands, all described in our documentation.

Dreamliner also offers **Dreamliner One**, an optional, paid, per-server subscription that unlocks certain premium features, billed and administered entirely through Discord's own monetization system (see section 10).

The Service is provided **only** as the hosted instance operated by us and reachable through the official invite link and dreamliner.site. **Self-hosting, forking, or operating your own copy of any part of the Service is not authorized, supported, or covered by these Terms**, even where portions of the underlying source code are made available under an open-source license (see section 12).

We may add, change, limit, or remove any feature of the Service at any time, for any reason, without liability to you, subject to section 17.

---

## 2. Eligibility

To use the Service, you must:

- Be able to form a legally binding contract under applicable law (which generally means you must be at least the age of majority in your jurisdiction, or have the consent of a parent or legal guardian);
- Meet Discord's own minimum age requirement (currently 13, and higher in some jurisdictions) and otherwise be permitted to use Discord under Discord's Terms of Service; and
- Not be barred from using the Service under the laws of any applicable jurisdiction, including export control, sanctions, or similar laws (see section 22).

**If you invite Dreamliner to a server, configure it, or grant it permissions, you represent and warrant that you have the actual authority to do so** (for example, ownership of the server or a role with Discord's "Manage Server" permission or equivalent), and that you have the authority to bind that server's other owners, administrators, and moderators to these Terms and to our Privacy Policy on their behalf. If you do not have that authority, you must not invite or configure the Service for that server.

---

## 3. Relationship to Discord

Dreamliner is an independent, third-party application built on top of Discord's public API and is **not** operated, endorsed, or sponsored by Discord Inc. Your use of Discord itself remains governed entirely by Discord's own [Terms of Service](https://discord.com/terms), [Community Guidelines](https://discord.com/guidelines), [Developer Policy](https://discord.com/developers/docs/policies-and-agreements/developer-policy), and [Privacy Policy](https://discord.com/privacy), all of which apply independently of, and in addition to, these Terms.

We are not responsible for Discord's availability, features, API changes, moderation decisions, account actions, or any loss you incur as a result of Discord's own conduct, including but not limited to Discord suspending, disabling, or removing the Dreamliner application, your Discord account, or your server.

---

## 4. Accounts, access, and security

Dreamliner does not issue its own separate username/password account. Dashboard access is provided exclusively through Discord's own OAuth2 sign-in. **You are responsible for maintaining the security of your own Discord account**, including your password and any two-factor authentication, and for all activity that occurs through the dashboard while authenticated as you, whether or not you authorized it.

You are responsible for controlling who in your organization or community has Discord's "Manage Server" permission and/or elevated Dreamliner Roles, since either can be used to reconfigure or misuse the Service for your server. We are not responsible for actions taken by anyone you have granted such access to, whether or not you intended for them to have it.

You must notify us promptly if you become aware of any unauthorized use of the Service in connection with your server or account, though we make no commitment as to what action, if any, we will take in response.

---

## 5. Acceptable use

You agree that you will not, and will not attempt to, use the Service to:

- Violate Discord's Terms of Service, Community Guidelines, Developer Policy, or any applicable law or regulation;
- Harass, bully, threaten, stalk, defame, or discriminate against any person or group;
- Organize, facilitate, or participate in raids, spam campaigns, denial-of-service activity, or other disruption of any Discord server, Discord itself, or the Service's own infrastructure;
- Upload, store, transmit, or process content that is illegal, that infringes another person's intellectual property or other rights, or that you do not have the right to process (including through custom commands, tags, logs, or archives);
- Upload, submit, or attempt to have approved (including through Custom Branding) content that is sexually exploitative of minors, that promotes terrorism or violent extremism, or that is otherwise manifestly unlawful; we will report such content to appropriate authorities where required or appropriate;
- Use the Service to impersonate any person, brand, or entity, including Dreamliner itself or its operators, or to misrepresent your affiliation with any person or entity;
- Reverse engineer, decompile, disassemble, or otherwise attempt to derive the source code of any part of the Service not made available to you under an open-source license, except to the extent such restriction is prohibited by applicable law;
- Probe, scan, or test the vulnerability of the Service, or attempt to breach any security or authentication measure, including the dashboard bridge, without our prior written authorization;
- Circumvent, disable, or otherwise interfere with permission systems, rate limits, Dreamliner Roles, Automod, Image Scanning, Impersonation Detection, Passport, or other security- or safety-related features of the Service, whether your own server's or another server's;
- Use automated means (bots, scrapers, or similar) to interact with the Service in a manner that imposes an unreasonable load on our infrastructure or Discord's;
- Resell, sublicense, or otherwise commercially exploit the Service, or any output of it, without our prior written consent; or
- Use the Service in any way that could damage, disable, overburden, or impair the Service or interfere with any other party's use of it.

**Server administrators bear full responsibility for how Dreamliner is configured and used within their community**, including the rules they configure for Automod, Image Scanning, Impersonation Detection, custom commands, logging, and any other feature, and for any consequence of a moderation action taken (automatically or manually) using the Service.

We reserve the right, but not the obligation, to investigate and take action against any violation of this section, up to and including removing Dreamliner from a server, disabling features, deleting content, and/or reporting conduct to Discord or to law enforcement, without prior notice and without liability to you.

---

## 6. Permissions, configuration, and your responsibilities

Dreamliner's functionality depends entirely on the Discord permissions and intents you grant it, and on how you and your administrators configure it. **You are solely responsible for**:

- Choosing which Discord permissions to grant Dreamliner, and understanding that granting a permission (for example, Manage Messages, Ban Members, Manage Roles, or Manage Server) allows Dreamliner, and anyone who can configure it, to exercise that permission on your server;
- Configuring Dreamliner Roles, `can_*` permission flags, and plugin settings correctly for your community, and reviewing them periodically;
- Choosing appropriate log channels, mute/timeout behavior, escalation ladders, protected roles, watchlists, and blocklist thresholds, and understanding that stricter settings increase the risk of false positives, while looser settings increase the risk of false negatives;
- Ensuring that any moderator or staff member you grant elevated access to understands the scope of power that access confers, including the ability to configure automated actions such as timeouts, kicks, or bans;
- Complying with any Discord privileged-intent requirements (including Message Content) applicable to your own server; and
- Backing up or otherwise preserving any configuration, content, or data you consider important, independently of our own retention practices described in the Privacy Policy.

We are not responsible for misconfiguration, for permissions you grant incorrectly or excessively, or for the consequences of configuration choices made by you or anyone you granted access to.

---

## 7. Moderation and automated actions generally

When enabled and configured to do so, Dreamliner may automatically or manually mute, time out, kick, ban, delete messages, send moderation notices (including DMs), post log entries, assign or remove roles, restrict channels, and take other actions consistent with the configuration you or your administrators set.

**You acknowledge and agree that:**

- Automated rules (Automod, Image Scanning, Impersonation Detection, custom filters, autodelete, and similar features) can and will, at times, affect users who have not actually violated any rule ("false positives"), and can and will, at times, fail to catch users who have ("false negatives");
- Case history, logs, and archives may retain moderation metadata, message content, or images (as fingerprints only, per the Privacy Policy) after an action has ended or been reversed;
- Failed message deliveries, Discord API limits, permission errors, role hierarchy conflicts, or Discord outages may prevent an intended action from completing, partially complete it, or delay it; and
- We do not review, approve, or endorse the substance of any moderation rule, filter, watchlist entry, or automated action any server configures.

**We are not responsible, and disclaim all liability, for moderation decisions made by your server's staff, for the substance or effect of rules your administrators configured, or for any harm arising from a false positive, false negative, delayed action, or failed action of any automated or manual feature of the Service.** This allocation of responsibility is a material part of the bargain between you and us in exchange for providing the Service, in whole or substantial part, free of charge.

---

## 8. Automated moderation and detection features specifically

Certain features, including Automod (and its Image Scanning rule and native Discord AutoMod sync), Impersonation Detection, and Passport, rely on automated pattern-matching, perceptual-hash comparison, or similarity scoring rather than human judgment or artificial general intelligence. You specifically acknowledge that:

- These features are heuristic in nature. They are designed to reduce, not eliminate, the incidence of scams, spam, and impersonation, and **no feature described in this section, or anywhere else in the Service, is a guarantee that any particular kind of content, account, or behavior will be detected, blocked, or prevented**, nor that legitimate content or accounts will never be flagged;
- Thresholds you configure (name-similarity percentages, perceptual-hash distances, and similar settings) involve an inherent trade-off between catching more violations and generating more false positives, and the choice of threshold is yours;
- Discord's own native AutoMod, where synced, operates as a wholly separate system under Discord's own policies once rules are mirrored into it, and we are not responsible for how Discord's systems apply those rules; and
- Where an administrator configures an automatic action (timeout, kick, or ban) rather than a staff-reviewed alert, that action will occur without human review at the moment of detection, and reversing an incorrect automatic action, if possible at all, is the responsibility of the server's own staff.

**You assume all risk arising from your choice to enable, configure, and rely upon any automated moderation or detection feature of the Service.**

---

## 9. Custom content, user submissions, and Custom Branding

Where the Service allows you to submit content for use by or through Dreamliner (custom commands built with Dreamcode, tags, welcome templates, filter patterns, watchlist entries, scam-image blocklist submissions, or a custom bot avatar/banner/display-name style through Custom Branding), you retain any ownership rights you may have in that content, subject to the license you grant us in section 12.

**We may review, reject, remove, or decline to publish any submitted content, at our sole discretion, for any reason or no reason, including but not limited to content we believe is unlawful, sexually exploitative of minors, extremist, infringing, impersonating, or otherwise inconsistent with these Terms**, and we are under no obligation to explain a rejection, to complete a review within any particular time, or to permit an appeal, although we may choose to do any of these as a courtesy.

Human review of submitted Custom Branding images, described in our Privacy Policy, is performed for policy-compliance purposes only and does not constitute any warranty, endorsement, or guarantee about the content reviewed.

---

## 10. Dreamliner One and payments

Dreamliner One is an optional, paid subscription tied to a specific Discord server, purchased and billed **exclusively through Discord's own guild-subscription/monetization system**. **We are not a party to the payment transaction, do not process or store your payment card or billing details, and are not the merchant of record.** Discord is solely responsible for billing, invoicing, tax handling, payment security, and refunds for Dreamliner One.

**Any billing dispute, refund request, failed payment, unauthorized charge, or similar payment issue must be directed to Discord**, through Discord's own support channels, and not to us. We will not be liable for any payment processing failure, billing error, unauthorized charge, or refund decision made by Discord.

We may change which features are included in Dreamliner One, discontinue Dreamliner One entirely, or change its price (subject to Discord's own mechanisms for communicating pricing changes) at any time. If we discontinue a specific Dreamliner One feature, we do not guarantee any refund, credit, or other compensation, though we may, at our sole discretion, work with Discord where feasible to reduce disruption.

---

## 11. Availability; no service level agreement

**We do not guarantee, and expressly disclaim, any uninterrupted availability, error-free operation, specific response time, specific uptime percentage, or continuity of any feature of the Service.** The Service may be unavailable, degraded, or behave unexpectedly due to factors including but not limited to: our own maintenance or deployments; bugs; capacity limits; Discord API changes, rate limits, outages, or policy changes; third-party service outages (see Privacy Policy section 3.9); force majeure events (section 21); or our decision to suspend or discontinue the Service, in whole or in part, at any time and for any reason.

We are under no obligation to provide advance notice of maintenance, changes, suspensions, or discontinuation, although we may choose to do so as a courtesy through documentation, a changelog, or an announcement channel.

---

## 12. Intellectual property

**Ours:** Dreamliner's name, logo, branding, documentation, dashboard design, and the Dreamliner-authored portions of the codebase are owned by the Dreamliner operators, except for third-party components and open-source libraries that are separately licensed. Where portions of the source code are made available under the MIT license or a similar open-source license, that license governs your rights to that code specifically; **it does not grant you any right to operate a hosted instance under the Dreamliner name or branding, to use our Discord application, client ID, or credentials, or to otherwise hold out any service you operate as being Dreamliner or affiliated with us.**

**Yours:** You retain ownership of configuration, custom commands, tags, and other original content you author and upload through the Service ("Your Content"). **By submitting Your Content to the Service, you grant us a worldwide, royalty-free, non-exclusive, sublicensable license to host, store, reproduce, display, transmit, and otherwise process Your Content solely to the extent necessary to operate, maintain, and improve the Service for you and, where applicable, for your server.** This license ends when Your Content is deleted from our systems, except to the extent it has been incorporated into aggregate or de-identified data, or retained as required by section 7 of the Privacy Policy or applicable law.

**Feedback:** If you send us feedback, suggestions, or ideas about the Service, you grant us an unrestricted, perpetual, irrevocable, royalty-free license to use them for any purpose, without any obligation or compensation to you.

---

## 13. Copyright and intellectual-property complaints

If you believe content accessible through the Service infringes your copyright or other intellectual-property rights, contact us through the channels in section 24 with enough detail to identify the material and your rights in it. We may, at our discretion, remove or disable access to material in response to a credible complaint, and may terminate access for repeat infringers, without thereby admitting any obligation to do so in any particular case.

---

## 14. Third-party services and links

The Service may send limited data to, or otherwise interoperate with, third-party services described in our Privacy Policy (including Google Translate, the YouTube Data API, and Nekos.best), and documentation or embeds produced by the Service may link to third-party websites. **We do not control, endorse, warrant, or accept any responsibility for the content, policies, availability, or practices of any third-party service or website**, and your use of any such third party is at your own risk and subject to that third party's own terms.

---

## 15. Privacy

Our collection, use, storage, and disclosure of information in connection with the Service is described in our [Privacy Policy](privacy-policy.md), which forms part of these Terms. By using the Service, you also agree to the Privacy Policy.

---

## 16. Disclaimers of warranties

**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE SERVICE IS PROVIDED STRICTLY ON AN "AS IS" AND "AS AVAILABLE" BASIS, WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE, INCLUDING, WITHOUT LIMITATION, ANY IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, OR QUIET ENJOYMENT, AND ANY WARRANTIES ARISING OUT OF COURSE OF DEALING OR USAGE OF TRADE.**

Without limiting the foregoing, **we do not warrant that**: the Service will meet your requirements; the Service will be uninterrupted, timely, secure, or error-free; any automated moderation, Automod rule, Image Scanning check, Impersonation Detection check, or Passport verification will catch every violation, raid, scam, or impersonation attempt, or will never produce a false positive; data will be preserved without loss, corruption, or unauthorized access; or any error in the Service will be corrected.

Any material obtained, or action taken, through your use of the Service is done at your own discretion and risk, and you will be solely responsible for any resulting damage, including to your Discord server, your devices, or your data.

Some jurisdictions do not allow the exclusion of certain implied warranties, so some of the above exclusions may not apply to you to that limited extent, in which case our warranties are limited to the minimum scope and duration required by applicable law.

---

## 17. Limitation of liability

**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL THE DREAMLINER OPERATORS, OR THEIR OFFICERS, CONTRIBUTORS, OR AGENTS, BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, GOODWILL, DATA, USE, OR SERVER ACCESS, HOWEVER CAUSED AND UNDER WHATEVER THEORY OF LIABILITY (INCLUDING CONTRACT, TORT, NEGLIGENCE, STRICT LIABILITY, OR OTHERWISE), ARISING OUT OF OR IN CONNECTION WITH THESE TERMS OR YOUR USE OF, OR INABILITY TO USE, THE SERVICE, EVEN IF THE DREAMLINER OPERATORS HAVE BEEN ADVISED OF, OR SHOULD HAVE KNOWN OF, THE POSSIBILITY OF SUCH DAMAGES.**

**WITHOUT LIMITING THE FOREGOING, THE DREAMLINER OPERATORS' TOTAL, AGGREGATE LIABILITY TO YOU FOR ALL CLAIMS ARISING OUT OF OR RELATING TO THE SERVICE OR THESE TERMS, WHETHER IN CONTRACT, TORT, OR OTHERWISE, WILL NOT EXCEED THE GREATER OF (A) ZERO US DOLLARS (USD $0), BECAUSE THE CORE, FREE FEATURES OF THE SERVICE ARE PROVIDED WITHOUT CHARGE, OR (B) THE TOTAL AMOUNT, IF ANY, ACTUALLY RECEIVED BY THE DREAMLINER OPERATORS (NET OF ANY AMOUNTS RETAINED BY DISCORD) FOR DREAMLINER ONE IN CONNECTION WITH THE RELEVANT SERVER IN THE TWELVE (12) MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM.**

This limitation applies regardless of the number of claims and regardless of whether any remedy set out in these Terms fails of its essential purpose. Some jurisdictions do not allow the exclusion or limitation of certain damages, so some of the above limitations may not apply to you to that limited extent, in which case liability will be limited to the greatest extent permitted by applicable law.

---

## 18. Assumption of risk; release

**By using the Service, you acknowledge that you understand and voluntarily assume all risks associated with automated content moderation, identity/image comparison, role and permission management, and any other automated feature of the Service, including the risk of erroneous, delayed, or absent action.** To the fullest extent permitted by law, you release the Dreamliner operators from any and all claims, demands, and damages of any kind arising out of or in any way connected with such risks, except where caused by our own fraud or willful misconduct as finally determined by a court of competent jurisdiction.

If you are a resident of a jurisdiction (such as California) with a statute similar to California Civil Code § 1542 (which provides, in substance, that a general release does not extend to claims a party does not know or suspect to exist in their favor at the time of executing the release), you expressly waive the protections of any such statute to the extent permitted by law, in connection with the release in this section.

---

## 19. Indemnification

**You agree to defend, indemnify, and hold harmless the Dreamliner operators, and their officers, contributors, and agents, from and against any and all claims, liabilities, damages, losses, costs, and expenses (including reasonable attorneys' fees) arising out of or in any way connected with:** (a) your server's or your own use or misuse of the Service; (b) any configuration, rule, filter, watchlist entry, or automated action you or your administrators set up; (c) Your Content, or any other content you store, process, or transmit through the Service; (d) your violation of these Terms, our Privacy Policy, Discord's own terms, or applicable law; or (e) your violation of any right of any third party, including intellectual-property, privacy, or publicity rights.

We reserve the right, at our own expense, to assume the exclusive defense and control of any matter otherwise subject to indemnification by you, in which case you agree to cooperate with our defense of such claim.

---

## 20. Termination

You may stop using the Service at any time by removing Dreamliner from your server, discontinuing use of its commands and dashboard, and (if applicable) canceling Dreamliner One through Discord.

**We may suspend or terminate your, or your server's, access to all or part of the Service at any time, with or without notice, for any reason or no reason, in our sole discretion**, including but not limited to a suspected violation of these Terms, abuse of the Service or of Discord's platform, a request or requirement from Discord, or a legal requirement.

Upon termination, your right to use the Service immediately ceases. Sections of these Terms that by their nature should survive termination will survive, including but not limited to sections 12 (Intellectual property, as to the license already granted), 13, 16, 17, 18, 19, 22, and 23.

Removal of the bot or termination of access does not automatically erase all previously stored data; see the Privacy Policy for retention and deletion.

---

## 21. Force majeure

We will not be liable for any failure or delay in performance of the Service resulting from causes beyond our reasonable control, including but not limited to acts of God, natural disaster, war, terrorism, riot, labor conditions, governmental action, internet or telecommunications failures, power outages, or failures or changes of Discord's own platform or API.

---

## 22. Export control and sanctions

You represent that you are not located in, under the control of, or a national or resident of any country or region subject to a comprehensive embargo under applicable export control or sanctions laws, and that you are not on any restricted-party or denied-persons list maintained by such laws. You agree not to use the Service in violation of any export control or economic sanctions law.

---

## 23. Dispute resolution; governing law; class action waiver

**Please read this section carefully. It affects your legal rights.**

**23.1 Informal resolution.** Before filing a claim against us, you agree to first contact us (section 24) and attempt in good faith to resolve the dispute informally for at least thirty (30) days.

**23.2 Arbitration agreement.** To the maximum extent permitted by applicable law, and except for disputes that qualify for small-claims court or that seek only injunctive relief for intellectual-property infringement, you and the Dreamliner operators agree that any dispute, claim, or controversy arising out of or relating to these Terms, the Privacy Policy, or the Service will be resolved by final and binding, individual arbitration rather than in court, except that either party may bring an individual action in small-claims court.

**23.3 Class action and jury trial waiver.** **To the fullest extent permitted by law, you and we each waive any right to a jury trial and to participate in a class action, class arbitration, or representative action against the other**, and any arbitration or proceeding will be conducted only on an individual basis, not on a class, collective, or representative basis, unless both parties agree otherwise in writing.

**23.4 Jurisdictional carve-outs.** Where applicable mandatory law (including certain consumer-protection laws of the European Union, the United Kingdom, or other jurisdictions) does not permit binding arbitration, a class-action waiver, or a particular limitation in this section for your specific claim, that specific provision will not apply to that claim to the extent, and only to the extent, required by that law, and the dispute will instead be resolved in accordance with the courts and procedures otherwise available to you under that law; the remainder of this section will continue to apply to the fullest extent still permitted.

**23.5 Governing law.** Except to the extent superseded by section 23.4, these Terms and any dispute arising out of or relating to them or the Service are governed by the substantive laws applicable where the Dreamliner operators are established, without regard to conflict-of-laws principles, and, where arbitration under 23.2 does not apply or is found unenforceable, the state and federal courts located there will have exclusive jurisdiction, and you consent to personal jurisdiction there.

---

## 24. Contact

For questions about these Terms, copyright/IP complaints, security reports, or informal dispute resolution under section 23.1, open an issue on the [Dreamliner repository](https://github.com/Clawb1t/Dreamliner) or contact the operators through any support channel linked from the bot or from dreamliner.site.

---

## 25. Miscellaneous

**Entire agreement.** These Terms, together with the Privacy Policy and any other legal notice or policy we publish and expressly incorporate by reference, constitute the entire agreement between you and us regarding the Service, and supersede any prior agreements between you and us regarding the Service.

**No waiver.** Our failure to enforce any right or provision of these Terms will not be considered a waiver of that right or provision.

**Severability.** If any provision of these Terms is held to be invalid or unenforceable, that provision will be limited or eliminated to the minimum extent necessary, and the remaining provisions will remain in full force and effect.

**Assignment.** You may not assign or transfer these Terms, by operation of law or otherwise, without our prior written consent. We may assign or transfer these Terms, in whole or in part, without restriction, including in connection with a merger, acquisition, reorganization, or sale of assets.

**No third-party beneficiaries.** Except as expressly stated, these Terms do not confer any rights or remedies on any person other than you and us.

**Relationship of the parties.** Nothing in these Terms creates any partnership, joint venture, employment, or agency relationship between you and us.

**Headings.** Section headings are for convenience only and do not affect interpretation of these Terms.

---

## 26. Changes to these Terms

We may update these Terms at any time, in our sole discretion, to reflect changes in the Service, our practices, or legal requirements. The "Last updated" date will change when we do. Material changes may also be announced through documentation, a changelog, or another reasonable means, at our discretion. **Your continued use of the Service after a change becomes effective constitutes your binding acceptance of the revised Terms**, except where applicable law requires additional notice or affirmative consent.

Related documents:

- [Privacy Policy](privacy-policy.md)
- [Getting started](getting-started.md)
- [Permissions setup](permissions.md)
