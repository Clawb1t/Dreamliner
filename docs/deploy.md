# Deploy to Hetzner (auto-update on push)

Every push to `main` SSHs into your Hetzner VPS, pulls the repo, rebuilds the Docker image, **re-registers slash commands**, and restarts the bot. SQLite lives in `/opt/dreamliner/data` and survives deploys.

## One-time server setup

SSH into the VPS as root (or a sudo user):

```bash
apt update && apt install -y git docker.io docker-compose-v2
systemctl enable --now docker

mkdir -p /opt/dreamliner
cd /opt/dreamliner
git clone https://github.com/Clawb1t/Dreamliner.git .

cp .env.example .env
nano .env
```

Fill at least:

```env
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=1524053555114151946
DATABASE_URL=file:./data/dreamliner.db
DOCS_BASE_URL=https://github.com/Clawb1t/Dreamliner/blob/main/docs
BOT_ACTIVITY=✈️ Airplanes
```

Then start once manually:

```bash
mkdir -p /opt/dreamliner/data
cd /opt/dreamliner
docker compose build
docker compose run --rm --no-deps bot npm run register-commands
docker compose up -d
docker compose logs -f bot
```

## One-time deploy SSH key

On your **local** machine (or the VPS):

```bash
ssh-keygen -t ed25519 -C "github-dreamliner-deploy" -f dreamliner-deploy -N ""
```

On the **Hetzner** server:

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
cat >> ~/.ssh/authorized_keys <<'EOF'
# paste contents of dreamliner-deploy.pub here
EOF
chmod 600 ~/.ssh/authorized_keys
```

## GitHub Actions secrets

In the repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
|--------|--------|
| `HETZNER_HOST` | VPS public IP or hostname |
| `HETZNER_USER` | SSH user (often `root`) |
| `HETZNER_SSH_KEY` | Full private key (`dreamliner-deploy` file contents) |

The workflow SSHs on port **22**. If you use a custom SSH port, edit `port` in `.github/workflows/deploy.yml`.

Do **not** put `DISCORD_TOKEN` in GitHub; it stays in `/opt/dreamliner/.env` on the server.

## After that

Push to `main` (or run the **Deploy to Hetzner** workflow manually). GitHub Actions will:

1. `git fetch` + `reset --hard origin/main`
2. `docker compose build`
3. `npm run register-commands` (slash command sync)
4. `docker compose up -d` (restart with new image)

Migrations also run automatically when the bot process starts.

## Useful commands on the server

```bash
cd /opt/dreamliner
docker compose ps
docker compose logs -f bot
docker compose restart bot
```
