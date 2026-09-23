# Applications plugin

Let members apply for roles and positions (Moderator, Event Host, Partner...) through custom forms.
Each **opening** is posted in a channel with an apply button; members fill in a Discord modal form, and
the application lands in a review channel where staff accept or deny it. Every application can also
be browsed and decided on the dashboard's **View Applications** page.

## Configuration

Dashboard-managed: build openings on the website's config editor, then press **Publish** to post
each one. Publishing an opening that's already posted edits the existing post in place.

```yaml
plugins:
  applications:
    enabled: true
    config:
      review_channel_id: "123456789012345678"   # default review channel
      openings:
        - id: "0b6f7a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b"
          name: "Moderator"
          accepting: true
          channel_id: "234567890123456789"       # where the opening is posted
          message:
            content: ""
            embed:
              enabled: true
              title: "{opening} applications are open"
              description: "Think you'd be a great fit? Hit the button below to apply."
          button: { label: "Apply", emoji: "📝", style: primary }
          questions:
            - id: "…"
              label: "Why do you want to join the team?"
              type: text
              style: paragraph
          ping_roles: ["345678901234567890"]
          review_thread: true
          required_roles: []
          blocked_roles: []
          min_account_age_days: 30
          min_member_days: 7
          cooldown_days: 7
          accept_roles: ["456789012345678901"]
          accept_remove_roles: []
          dm_decision: true
          accept_message: "🎉 Your application for **{opening}** in **{guild}** was accepted. Welcome aboard!"
          deny_message: "Thanks for applying for **{opening}** in **{guild}**. Unfortunately it wasn't accepted this time."
```

### Openings

| Field | Description |
|-------|-------------|
| `name` / `description` | What members apply for. Shown as `{opening}` / `{opening_description}`. |
| `enabled` / `accepting` | `accepting: false` pauses an opening: the post stays, but its button greys out (after the next publish) and presses are refused. |
| `channel_id`, `message`, `button` | The post: text plus a welcomer-style embed, and the apply button's label, emoji, and color. |
| `modal_title` | Form title. Defaults to `<opening> application`. |
| `questions` | Up to 20, using the same question types as ticket forms (text, selects, radio/checkbox groups, file uploads, text blocks). Discord shows at most 5 per modal, so every 5 questions become one page and members press **Continue** between pages. |
| `review_channel_id` | Where this opening's applications go (falls back to the plugin-wide one). |
| `ping_roles` | Roles pinged when a new application arrives. |
| `review_thread` | Start a discussion thread on each application. |
| `required_roles` / `blocked_roles` | Who may apply. |
| `min_account_age_days` / `min_member_days` | Minimum account age / time in the server. |
| `cooldown_days` | How long a denied applicant waits before applying again. |
| `accept_roles` / `accept_remove_roles` | Roles granted / removed on acceptance. |
| `dm_decision`, `accept_message`, `deny_message` | DM the applicant with the decision. Supports `{user}`, `{opening}`, `{guild}`, `{reason}`; a deny reason is added on its own line if the template doesn't use `{reason}`. |

## Reviewing

Each application is posted as an embed with every answer, the applicant's account age, and
**Accept** / **Deny** buttons (Deny asks for an optional reason). Reviewers need `can_review`, granted
to the built-in **Moderator** role by default. Files uploaded in the form are re-attached to the review
message. Once decided, the message updates with the verdict and its buttons disable; two reviewers
pressing at once can't double-apply a decision.

Members can only have one pending application per opening.

## Requirements

- **Send Messages** and **Embed Links** in the opening and review channels (**Create Public Threads**
  for review threads).
- **Manage Roles**, with Dreamliner's role above every accept role.
