# DevOps Guide

A complete deployment workflow for the Scraper Dashboard: VPS provisioning,
GitHub repo + Actions, and the day-to-day push-to-deploy flow.

---

## 1. VPS Specs (recommended)

For 10 profiles × persistent Chrome instances + a Node server + MongoDB + Caddy
all on one box:

| Item | Recommended | Why |
|---|---|---|
| **Provider** | Hetzner Cloud, Vultr, Contabo, DigitalOcean | Pick by latency/budget |
| **Region** | Singapore / Jakarta / Tokyo | Close to your scrape targets |
| **OS** | **Ubuntu 22.04 LTS** | Stable, huge ecosystem |
| **CPU** | 4 vCPU minimum, 6–8 ideal | Each Chrome ≈ 0.3 vCPU peak |
| **RAM** | **8 GB minimum, 16 GB comfortable** | Chrome ≈ 300–600 MB each + Mongo 500 MB–1 GB |
| **Disk** | **100 GB SSD/NVMe** | Profiles + Docker images + Mongo data + backups |
| **Network** | 1 Gbps, IPv4 included | Standard |

MongoDB runs **on the same VPS as a Docker container**. It is bound to the
internal Docker network only — **no public port exposure**.

---

## 2. One-Time VPS Bootstrap

After provisioning, SSH in as `root` and run this once:

```bash
# Update + essentials
apt update && apt upgrade -y
apt install -y curl git ufw fail2ban

# Firewall: SSH + HTTPS only
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable

# Add your GitHub Actions deploy key's PUBLIC key so Actions can SSH in as root:
mkdir -p /root/.ssh
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIqp6oCPnneZUOmKYNJpiPrevPAKuUQSn4PBpe4cw+nt sltheesan@gmail.com github-deploy" >> /root/.ssh/authorized_keys
chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys

# Install Docker
curl -fsSL https://get.docker.com | sh

# Disable password SSH (keep root key login allowed)
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart ssh
```

SSH in as `root@your-vps-ip` for all subsequent stages.

> **Note:** running everything as `root` is simpler but less secure than the
> usual non-root `deploy` user. For this single-tenant scraper VPS, the
> trade-off is acceptable.

---

## 3. Git Repo Setup (one-time)

On your **MacBook**, inside the project dir:

```bash
git init
git add .
git commit -m "Initial commit"

# Create an empty repo on github.com first, then:
git remote add origin git@github.com:<you>/scraper-app.git
git branch -M main
git push -u origin main
```

Make the repo **private** — your `.env` won't be in it, but it's still your
business logic + selectors.

---

## 4. Branch & Push Workflow (day-to-day)

```bash
git checkout -b feature/recent-scrapes-view   # for a new change
# … edit code …
git add -p                                    # review hunks
git commit -m "Add recent scrapes view"
git push -u origin feature/recent-scrapes-view
```

On GitHub → open PR → review → merge to `main` → GitHub Actions deploys.

For quick fixes, you can push directly to `main` — deploy auto-runs.

---

# Part B — Beginner Walk-Through: Setting Up CI/CD

If CI/CD is new to you, do these stages **in order**. Each stage explains
what you're doing, why, the exact commands, and how to verify it worked.

## The big picture

Here's the whole flow once it's set up:

```
You: `git push origin main`
   │
   ▼
GitHub Actions: builds a Docker image of your app
   │
   ▼
GitHub Actions: pushes the image to ghcr.io (GitHub's image registry)
   │
   ▼
GitHub Actions: SSHes into your VPS and runs `docker compose pull && up -d`
   │
   ▼
VPS: downloads the new image and restarts the app container
   │
   ▼
Users: see the new version at https://yourdomain.com
```

Three "actors" cooperate: **your Mac** (where you write code), **GitHub**
(stores code, runs Actions, hosts the Docker image), and **the VPS** (runs
the live app).

## Setup stages overview

```
Stage 1   Get a VPS                            (~15 min)
Stage 2   Bootstrap the VPS                    (~10 min)
Stage 3   Buy a domain + point DNS             (~5 min + DNS wait)
Stage 4   Generate the deploy SSH key          (~5 min)
Stage 5   Create a GHCR access token           (~3 min)
Stage 6   Add the 5 deploy files to the repo   (~5 min — I generate these)
Stage 7   Set GitHub Actions secrets           (~5 min)
Stage 8   First-time app setup on the VPS      (~10 min)
Stage 9   First Actions-driven deploy          (~5 min, mostly waiting)
Stage 10  Verify the dashboard works           (~5 min)
Stage 11  Transfer login sessions to the VPS   (~10 min)
Stage 12  Configure daily Mongo backups        (~5 min)
─────────────────────────────────────────────
Total first-time setup: about 90 minutes
```

After that the daily workflow is just `git push`.

---

## Stage 1 — Get a VPS

**What you're doing:** renting a Linux server in the cloud.

1. Sign up at a provider — Hetzner Cloud (cheapest), DigitalOcean (easiest
   UI), or Vultr (good Asia coverage).
2. Create a server with:
   - **Image:** Ubuntu 22.04 LTS
   - **Type:** 4 vCPU / 8 GB RAM
   - **Region:** Singapore (closest to your scrape targets)
   - **SSH key:** paste your Mac's public key (`cat ~/.ssh/id_ed25519.pub`)
     so you can log in passwordless
3. Note the public **IPv4 address** — you'll use it everywhere.

**Verify:**

```bash
ssh root@YOUR_VPS_IP
# you should see Ubuntu's welcome banner
exit
```

**If SSH refuses:** check the provider's web UI for a firewall toggle —
some require you to manually allow incoming SSH.

---

## Stage 2 — Bootstrap the VPS

**What you're doing:** locking down the server and installing Docker.

Run the block from **§2** above as `root`. The script adds your GitHub
Actions deploy key (Stage 4 below) to `/root/.ssh/authorized_keys` so the
workflow can SSH in as root. Replace the example `ssh-ed25519 AAAA…` line
with whichever public key you want to authorize on first login.

**Verify:**

```bash
# From your Mac:
ssh root@YOUR_VPS_IP
docker --version              # should print Docker version 27.x or similar
exit
```

**If `docker` is "command not found":** the install script silently failed —
re-run `curl -fsSL https://get.docker.com | sh` as root.

---

## Stage 3 — Buy a domain and point DNS

**What you're doing:** getting an HTTPS-friendly URL.

1. Buy a domain at Cloudflare or Namecheap (~$10/yr).
2. In your registrar's DNS settings, add an **A record**:
   - **Name:** `@` (root) or a subdomain like `scraper`
   - **Type:** `A`
   - **Value:** `YOUR_VPS_IP`
   - **TTL:** default
3. Wait 5–30 minutes for DNS to propagate.

**Verify:**

```bash
dig +short yourdomain.com
# Should print YOUR_VPS_IP
```

**If you skip this stage:** Caddy can't get an HTTPS certificate. The app
will still work on the raw IP over HTTP, but don't ship that to real users.

---

## Stage 4 — Generate the deploy SSH key

**What you're doing:** GitHub Actions needs its own SSH key (separate from
your personal one) to log into the VPS during the deploy step.

```bash
# On your MacBook:
ssh-keygen -t ed25519 -f ~/.ssh/gh-scraper-deploy -N ""
```

This creates two files:

- `~/.ssh/gh-scraper-deploy` — the **private** key (goes into a GitHub
  secret in Stage 7; never share)
- `~/.ssh/gh-scraper-deploy.pub` — the **public** key (goes onto the VPS)

Authorize the public half on the VPS as root:

```bash
ssh root@159.223.49.68 \
  "cat >> /root/.ssh/authorized_keys" < ~/.ssh/gh-scraper-deploy.pub
```

**Verify:**

```bash
ssh -i ~/.ssh/gh-scraper-deploy root@159.223.49.68 "whoami"
# Should print: root
```

Keep the private key file around — Stage 7 needs it.

---

## Stage 5 — Create a GHCR access token

**What you're doing:** the VPS needs to `docker pull` your private image
from GitHub Container Registry. It needs its own credential to do so.

1. Open https://github.com/settings/tokens?type=beta
2. Click **Generate new token (fine-grained)**.
3. Token name: `scraper-app GHCR read`
4. Expiration: 1 year (your call)
5. **Repository access:** only `sltheesan/scraper-app`
6. **Permissions → Repository → Packages:** Read-only
7. Click **Generate**, then **copy the token** (you only see it once).

Save it temporarily in your password manager — Stage 7 needs it.

---

## Stage 6 — Add the 5 deploy files to your repo

**What you're doing:** putting the build recipe + run recipe + CI workflow
into git so GitHub can act on them.

The five files are:

| File | What it does |
|---|---|
| `Dockerfile` | Tells Docker how to build your app image |
| `.dockerignore` | What to skip when building (similar to .gitignore) |
| `docker-compose.yml` | Describes the 3-container runtime (app + mongo + caddy) |
| `Caddyfile` | Reverse-proxy + automatic HTTPS config |
| `.github/workflows/deploy.yml` | The GitHub Actions pipeline |

**You don't have to write these by hand.** Reference templates are in
appendices §17–§21. When you give me your VPS IP, domain, and GitHub
username (see §22 at the bottom), I'll commit the right ones for you.

For now, once you have them in the repo:

```bash
git add Dockerfile .dockerignore docker-compose.yml Caddyfile .github/workflows/deploy.yml
git commit -m "Add Docker + CI/CD"
# Don't push yet — Stage 7 first.
```

---

## Stage 7 — Set the GitHub Actions secrets

**What you're doing:** GitHub Actions needs credentials to log into your
VPS and to pull from GHCR. We give it those credentials via "secrets" —
encrypted env vars only the workflow can read.

Go to: your repo → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**. Add four:

| Secret name | What to paste |
|---|---|
| `VPS_HOST` | The VPS IPv4 address |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | The **full contents** of `~/.ssh/gh-scraper-deploy` (the private key). Open it with `cat ~/.ssh/gh-scraper-deploy` and copy from `-----BEGIN OPENSSH PRIVATE KEY-----` to `-----END OPENSSH PRIVATE KEY-----` inclusive. |
| `GHCR_READ_TOKEN` | The token text from Stage 5 |

**Verify:** all four appear under "Repository secrets" on the same page.

(`GITHUB_TOKEN` is provided automatically — don't add it as a secret.)

---

## Stage 8 — First-time app setup on the VPS

**What you're doing:** placing `docker-compose.yml`, `Caddyfile`, and
`.env` on the VPS, then booting the stack manually once to confirm
everything works before turning it over to Actions.

SSH in as `root`, then:

```bash
mkdir -p /root/scraper-app/volumes/{profiles,mongo_data,caddy_data,caddy_config}
mkdir -p /root/scraper-app/backups
cd /root/scraper-app

# Place the three files manually:
nano docker-compose.yml       # paste contents from §19, change image name to your repo
nano Caddyfile                # paste contents from §20, replace yourdomain.com
nano .env                     # paste contents from §15, fill in real secrets
chmod 600 .env

# One-time GHCR login. Actions repeats this on every deploy automatically.
echo PASTE_YOUR_GHCR_TOKEN | \
  docker login ghcr.io -u sltheesan --password-stdin

# Boot the stack
export TAG=latest
docker compose pull
docker compose up -d
```

**Verify:**

```bash
docker compose ps
# All three services (app, mongo, caddy) should be in state "Up".

docker compose logs -f app
# You should see "MongoDB connected" and "scheduler started".
# Press Ctrl+C to stop tailing.
```

Then in your browser visit `https://yourdomain.com`. Caddy fetches a
Let's Encrypt cert on first request (may take 20–30 seconds) and you should
see the login screen.

**Common gotchas:**

- `docker login` fails → token doesn't have `read:packages` permission.
- App container exit-loops → check `docker compose logs app`. 99% of the
  time it's a typo in `.env` (e.g. `MONGO_URL` doesn't match
  `MONGO_INITDB_ROOT_PASSWORD`).
- Browser shows "ERR_SSL_PROTOCOL_ERROR" → DNS hasn't propagated yet, or
  Caddy is still issuing the cert. Wait a minute, refresh.

---

## Stage 9 — First Actions-driven deploy

**What you're doing:** confirming the GitHub → VPS pipeline works end-to-end.

On your Mac:

```bash
git push origin main
```

Open your repo → **Actions** tab → click the latest workflow run. You'll
see two jobs:

- ✅ **build** — builds the Docker image, pushes to GHCR (~2–3 min)
- ✅ **deploy** — SSHs to the VPS, runs `docker compose pull && up -d` (~30s)

When both are green, the new code is live on `https://yourdomain.com`.

**If the build job fails:** read the Dockerfile build log. Usually a syntax
error in the Dockerfile or a Node dependency that needs a system package.

**If the deploy job fails:**

- `Permission denied (publickey)` → the `VPS_SSH_KEY` secret is wrong, or
  the public half isn't in `/root/.ssh/authorized_keys` on the VPS.
- `pull access denied` → the `GHCR_READ_TOKEN` is wrong, or doesn't have
  `read:packages`.
- `docker: command not found` → Docker wasn't installed by Stage 2 — re-run
  `curl -fsSL https://get.docker.com | sh` on the VPS as root.

---

## Stage 10 — Verify the dashboard works

1. Visit `https://yourdomain.com` → log in with the credentials in your
   production `.env`.
2. Click **+ New profile**, add a test profile.
3. Click **Edit** on the profile → form opens, fields are populated.

**Don't click Fetch yet** — there's no logged-in browser session on the
VPS until Stage 11.

---

## Stage 11 — Transfer login sessions to the VPS

**What you're doing:** copying the `profiles/` folder (with the cookies and
local storage you painstakingly logged in to acquire) from your Mac to
the VPS, so the headless server can pick up where you left off.

```bash
# On your Mac, in the project root:
rsync -avz --delete ./profiles/ \
  root@YOUR_VPS_IP:/root/scraper-app/volumes/profiles/
```

Now back in the dashboard, click **Fetch** on a profile — should work
exactly like local.

For new logins after this, your options are:

- **A (simplest)**: Login locally on your Mac → `rsync` again. Repeat as
  sessions expire.
- **B (best long-term)**: Install Xvfb + noVNC inside the app container so
  the **Login** button in the dashboard works directly on the VPS. Punt
  this until you actually need it.

---

## Stage 12 — Configure daily Mongo backups

**What you're doing:** protecting the Mongo data so you can recover from
disk loss or accidental deletion.

SSH in as `root`:

```bash
nano /etc/cron.daily/mongo-backup
```

Paste this:

```bash
#!/usr/bin/env bash
set -e
docker exec scraper-app-mongo-1 mongodump --archive --gzip \
  -u root -p "$MONGO_PASSWORD" --authenticationDatabase admin \
  > /root/scraper-app/backups/mongo-$(date +%F).gz
find /root/scraper-app/backups -name "mongo-*.gz" -mtime +7 -delete
```

Then:

```bash
chmod +x /etc/cron.daily/mongo-backup

# Tell cron the Mongo password:
echo 'MONGO_PASSWORD=THE_PASSWORD_FROM_ENV' >> /etc/environment
# (re-login as root for it to take effect)

# Test it now:
MONGO_PASSWORD=THE_PASSWORD_FROM_ENV /etc/cron.daily/mongo-backup
ls -lh /root/scraper-app/backups/
# You should see a fresh mongo-YYYY-MM-DD.gz file.
```

Later, add an `rclone` job to copy `backups/` to S3 / Backblaze for offsite
safety.

---

## You're done.

From here on, your daily workflow is:

```bash
git add -p
git commit -m "Fix X"
git push origin main
# Open Actions tab; wait 3-5 min; refresh dashboard.
```

That's it.

---

# Part C — Reference Material

Everything below is for lookup — not stuff you need to read top-to-bottom.

## 13. Image Versioning Strategy

Every CI run produces multiple tags for the same image, so you can roll
forward or back with surgical precision:

| Tag | When set | Use for |
|---|---|---|
| `:sha-<short>` | every commit on `main` | The identifier of any deploy — immutable |
| `:latest` | every commit on `main` | What the VPS pulls by default |
| `:vX.Y.Z` | when you push a git tag `vX.Y.Z` | Explicit release |
| `:vX.Y` | derived from the same tag | Floating to the latest patch |

### Cut a release

```bash
git tag v1.0.0
git push origin v1.0.0
```

### Roll back on the VPS

```bash
cd ~/scraper-app
export TAG=sha-abc1234        # or v0.9.4 — any tag that exists in GHCR
docker compose pull
docker compose up -d
```

---

## 14. Production File Layout on the VPS

```
/root/scraper-app/
├── docker-compose.yml          ← placed by hand
├── Caddyfile                   ← placed by hand
├── .env                        ← production secrets, NEVER in git
├── backups/                    ← daily mongodump output (7-day retention)
└── volumes/
    ├── profiles/               ← persistent browser data (survives deploys)
    ├── mongo_data/             ← MongoDB data files (survives deploys)
    ├── caddy_data/             ← Let's Encrypt certs
    └── caddy_config/           ← Caddy state
```

`docker compose pull && up -d` replaces the app container but **keeps every
`volumes/*` mount** — Chrome sessions and Mongo data survive deploys.

```
┌──────────────────────────────────────────┐
│  internal docker network                 │
│                                          │
│  caddy ──► app ──► mongo                 │
│   ▲                                      │
│   │ ports 80/443 published               │
└───┼──────────────────────────────────────┘
    │
  internet
```

---

## 15. Production `.env` (template)

```bash
NODE_ENV=production
PORT=3000

# Internal Docker DNS — never exposed to the public internet
MONGO_URL=mongodb://root:STRONG_PASSWORD@mongo:27017/scraper?authSource=admin

ADMIN_USERNAME=admin
ADMIN_PASSWORD=PICK_SOMETHING_STRONG
JWT_SECRET=GENERATE_WITH_openssl_rand_base64_48

HEADLESS=true
BROWSER_CHANNEL=chrome

# Mongo container reads these on first boot to initialise the root user.
# MUST match the password embedded in MONGO_URL above.
MONGO_INITDB_ROOT_USERNAME=root
MONGO_INITDB_ROOT_PASSWORD=STRONG_PASSWORD
```

Generate the strong password and JWT secret:

```bash
openssl rand -base64 32   # Mongo password
openssl rand -base64 48   # JWT secret
```

---

## 16. Common Operations Cheat-Sheet (on the VPS)

```bash
# See running containers + image versions
docker compose ps

# Tail app logs
docker compose logs -f app

# Restart just the app (e.g. after editing .env)
docker compose up -d app

# Pull a specific version
export TAG=sha-abc1234         # or v1.0.0
docker compose pull app
docker compose up -d app

# Roll back to a previous build
docker images ghcr.io/sltheesan/scraper-app     # find a prior tag
export TAG=<prior_tag>
docker compose up -d app

# Mongo shell (inside the running container)
docker exec -it scraper-app-mongo-1 mongosh \
  -u root -p "$MONGO_PASSWORD" --authenticationDatabase admin
```

---

## 17. `Dockerfile` template

```dockerfile
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

# Install Google Chrome stable so channel:'chrome' works at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget gnupg ca-certificates \
 && wget -qO- https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/profiles && chown -R pwuser:pwuser /app
USER pwuser

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
```

---

## 18. `.dockerignore` template

```
node_modules
profiles
.env
.env.*
.git
.github
.vscode
.idea
.claude
*.md
```

---

## 19. `docker-compose.yml` template (lives on the VPS)

```yaml
services:
  app:
    image: ghcr.io/sltheesan/scraper-app:${TAG:-latest}
    restart: unless-stopped
    env_file: .env
    depends_on:
      - mongo
    volumes:
      - ./volumes/profiles:/app/profiles
    networks: [internal]
    expose: ["3000"]

  mongo:
    image: mongo:7
    restart: unless-stopped
    environment:
      MONGO_INITDB_ROOT_USERNAME: ${MONGO_INITDB_ROOT_USERNAME}
      MONGO_INITDB_ROOT_PASSWORD: ${MONGO_INITDB_ROOT_PASSWORD}
    volumes:
      - ./volumes/mongo_data:/data/db
    networks: [internal]
    # No `ports:` — Mongo is private to the docker network.

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./volumes/caddy_data:/data
      - ./volumes/caddy_config:/config
    depends_on:
      - app
    networks: [internal]

networks:
  internal:
```

---

## 20. `Caddyfile` template (lives on the VPS)

```
yourdomain.com {
  encode gzip
  reverse_proxy app:3000 {
    # SSE for the live activity log — disable buffering.
    flush_interval -1
  }
}
```

---

## 21. `.github/workflows/deploy.yml` template

```yaml
name: Build & Deploy

on:
  push:
    branches: [main]
    tags: ['v*']
  workflow_dispatch: {}

env:
  IMAGE: ghcr.io/${{ github.repository_owner }}/scraper-app

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Compute image tags
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.IMAGE }}
          tags: |
            type=sha,prefix=sha-,format=short
            type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main' }}
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}

      - name: Build & push image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Deploy on VPS via SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          envs: GITHUB_SHA,GITHUB_ACTOR
          script: |
            set -e
            cd /root/scraper-app
            export TAG=sha-${GITHUB_SHA::7}
            echo "${{ secrets.GHCR_READ_TOKEN }}" \
              | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
            docker compose pull
            docker compose up -d
            docker image prune -f
            docker compose ps
```

---

## 22. What to Provide When You're Ready to Wire This Up

Send back:

- VPS public IP (after Stage 1)
- Your domain name (after Stage 3)
- GitHub username + repo name (e.g. `sltheesan/scraper-app`)
- Your login strategy (A or B from Stage 11)

I'll then commit the 5 deploy files (§17–§21) with your specific values
already filled in — no copy-paste-and-edit dance.
