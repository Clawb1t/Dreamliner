# Raid Defense Mesh plugin

Link your server with others you trust so a raid on one instantly alerts the others, naming the accounts involved. There are no Discord commands — mesh links, invites, and alert delivery are all managed from the **dashboard**.

## How it works

1. From the dashboard, a server generates a one-time invite code (valid for 24 hours).
2. Staff share that code with a server they want to link with — outside Dreamliner, however they normally coordinate.
3. The other server redeems the code from its own dashboard. Redeeming creates a **mutual** link between both servers; the invite code is consumed either way.
4. From then on, whenever either linked server's own raid detector (part of [Automod](automod.md)) trips, Dreamliner posts an alert to every server it's linked with, naming the accounts involved in the burst so their staff can pre-emptively watch or ban them.
5. Either side can unlink at any time from the dashboard. Unlinking removes the connection for both servers.

The mesh only ever reacts to an already-detected raid on a linked server — it never triggers alerts on its own, and it doesn't take any automatic action (kick/ban) against the named accounts; that decision is left to your staff, or handled separately by [Incident Response](incident_response.md) if you have lockdown policies configured there.

## Configuration

```yaml
plugins:
  raid_mesh:
    enabled: false
    config:
      alert_channel_id: ""
```

| Field | Description |
|-------|-------------|
| `enabled` | Must be `true` to receive and send mesh alerts (opt-in; off by default). |
| `alert_channel_id` | Where incoming alerts from linked servers are posted. Falls back to the moderation log channel when unset. |

Linked servers, pending invites, and alert history are operational data managed entirely from the dashboard — there's nothing else to configure in YAML.

## Requirements

- The bot needs to be present in both servers for a link to receive alerts (it can't post to a server it isn't in).
- A working moderation log channel (or an explicit `alert_channel_id`) so alerts have somewhere to land.

## Setup

1. In the dashboard, open **Raid Defense Mesh** and enable the plugin.
2. Click **Create invite** and send the resulting code to the other server's staff through whatever channel you already use to coordinate (DM, shared support server, etc.).
3. The other server pastes the code into their own dashboard's **Raid Defense Mesh** page to redeem it.
4. Optionally set a dedicated `alert_channel_id` on either side if you don't want mesh alerts landing in the general moderation log.
