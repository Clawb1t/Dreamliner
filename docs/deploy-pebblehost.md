# Deploy on PebbleHost

Dreamliner runs on [PebbleHost Discord bot hosting](https://pebblehost.com/nodejs-discord-bot-hosting) (Pterodactyl panel). This is the easy path if you do not want to manage a VPS.

**Trade-off:** updates are usually “pull / upload then restart,” not automatic on every GitHub push (unless you use their Git tools manually). For push-to-deploy, use [Hetzner](deploy.md) instead.

---

## 1. Order a bot plan

1. Open [PebbleHost NodeJS Discord bot hosting](https://pebblehost.com/nodejs-discord-bot-hosting).
2. Order the **NodeJS** bot plan (not a Minecraft server).
3. Pick **EU** or **NA**.
4. Wait for the welcome email / panel access.

Panel: usually `https://panel.pebblehost.com` (or the URL in your email).

---

## 2. Create / open the bot server

In the panel:

1. Open your bot server.
2. Use a **blank / custom NodeJS** setup.
3. Do **not** use one-click preinstalls (Bastion, music bots, etc.). Those replace Dreamliner.

### Startup settings

Go to **Startup** (names vary slightly):

| Setting | Value |
|---------|--------|
| **Node.js version** | **20** (or newer LTS). Must be `>=20`. |
| **Main file / start command** | Prefer a custom startup if available: `npm run panel:start` |
| If you can only set a JS file | Build first, then set main file to `dist/index.js` |

If the egg only runs `node <file>`:

1. Open **Startup** and set Node to 20+.
2. Use the **Console** once to install/build (see below), then point the main file at `dist/index.js`.

---

## 3. Put Dreamliner on the server

### Option A: Git (best)

PebbleHost advertises **Git Management** on bot plans:

1. In the panel, open **Git** / **Version Control** (or similar).
2. Clone: `https://github.com/Clawb1t/Dreamliner.git`
3. Branch: `main`
4. Pull whenever you want updates, then **Restart**.

If there is no Git UI, use the console (if SFTP/SSH shell is available) or Option B.

### Option B: Upload a zip

On your PC:

1. Download the repo ZIP from GitHub, **or** zip the project **without** `node_modules`, `.env`, and `data/`.
2. Panel → **Files** → upload and extract into `/home/container` (root of the server).
3. You should see `package.json`, `src/`, `drizzle/`, etc. at the top level.

---

## 4. Environment variables

Do **not** upload your local `.env` if it has secrets you are unsure about. Prefer panel variables when available.

Create a `.env` in the file manager:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=1524053555114151946
DATABASE_URL=file:./data/dreamliner.db
DOCS_BASE_URL=https://github.com/Clawb1t/Dreamliner/blob/main/docs
BOT_ACTIVITY=✈️ Airplanes
```

Or set the same keys under **Startup** variables if the egg supports them.

Enable your Discord intents (including **Message Content**) in the [Developer Portal](https://discord.com/developers/applications).

---

## 5. First start

### If startup is `npm run panel:start`

Click **Start**. That script runs:

1. `npm install`
2. `npm run build`
3. `npm start` (migrations run automatically on boot)

### If you must use the console

Stop the server, open **Console**, then run:

```bash
npm install
npm run build
npm run register-commands
```

Then set the main file to `dist/index.js` and click **Start**.

### Slash commands

Register once after the first successful install/build:

```bash
npm run register-commands
```

Run again whenever you add or change slash commands and redeploy.

---

## 6. Updating Dreamliner later

1. **Git pull** in the panel (or re-upload files).
2. Restart, or run:

```bash
npm install
npm run build
npm run register-commands
```

3. **Start** the server again.

SQLite lives under `data/`. Leave that folder alone when uploading so you keep configs and cases.

---

## 7. Common issues

| Problem | Fix |
|---------|-----|
| `engines` / old Node | Set Node **20+** in Startup |
| `better-sqlite3` build fails | Ask PebbleHost support to enable build tools, or open a ticket; that package needs native compile on first install |
| Bot starts then silent | Check token, intents, and console errors |
| Commands missing | Run `npm run register-commands` again |
| Lost config after reinstall | You wiped `data/`; restore from panel backups if available |

---

## 8. Invite the bot

Use the invite from the [README](../README.md), then in Discord:

1. `/config template`
2. Edit YAML (`levels`, channels, etc.)
3. `/config upload`

---

## Support

- PebbleHost: their Discord / ticket system from the panel
- Dreamliner config docs: [Getting started](getting-started.md)
