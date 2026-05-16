# Multi-Profile Browser Scraper

A 24/7 automated web scraping system that maintains multiple authenticated browser sessions, periodically refreshes them to keep sessions alive, scrapes data on each refresh, and pushes the data to a MongoDB database.

## Overview

Some websites require login to access data, time out idle sessions, and reveal data only after a button click. Manually keeping 10+ sessions alive and scraping them every few minutes is impractical. This project automates that loop.

The system:

1. Manages 10+ persistent browser profiles (each profile = one logged-in account)
2. Refreshes each profile on a configurable interval (e.g. every 5–10 minutes) to prevent session timeout
3. Clicks a target button to reveal data after each refresh
4. Scrapes that data and writes it to MongoDB
5. Provides a web dashboard for monitoring profile health, viewing logs and recent scrapes, and triggering manual re-login when sessions expire
6. Runs entirely headless once initial logins are done — no GUI/RDP required for steady-state operation

## Features

- **Persistent browser sessions** — cookies and storage survive restarts via Playwright's `launchPersistentContext`
- **Manual login flow** — log in once per profile through a remote browser view; automation takes over afterward
- **Configurable refresh cycles** — per-profile interval with jitter to avoid suspicious patterns
- **Resilient scraping loop** — retries, error logging, automatic detection of expired sessions
- **Web dashboard** — real-time status grid, log streaming, restart/pause controls
- **Optional remote browser view** — embedded noVNC for in-dashboard manual logins (no RDP client needed)
- **Pluggable storage** — MongoDB locally for dev, separate DB VPS in production
- **Optional proxy per profile** — assign residential/datacenter proxies if the target site flags shared IPs
- **Dockerized** — reproducible builds, easy deployment
- **Git-based deployment** — push to `main` → GitHub Actions builds image → VPS pulls and restarts

## Architecture

### Development (local — MacBook)

```
┌────────────────────────────────────────────┐
│  MacBook                                   │
│                                            │
│  ┌──────────────┐    ┌──────────────────┐  │
│  │  Node app    │───►│  MongoDB         │  │
│  │  (Fastify +  │    │  (Docker         │  │
│  │  Playwright) │    │   container)     │  │
│  └──────┬───────┘    └──────────────────┘  │
│         │                                  │
│         ▼                                  │
│   profiles/  (browser user-data dirs)      │
└────────────────────────────────────────────┘
            ▲
            │ http://localhost:3000
        web browser
```

### Production (planned)

```
┌──────────────────────┐         ┌──────────────────────┐
│  Scraper VPS         │ ──────► │  Database VPS        │
│  ┌────────────────┐  │  Tail-  │  ┌────────────────┐  │
│  │ Caddy (HTTPS)  │  │  scale  │  │ MongoDB        │  │
│  └────────┬───────┘  │  / VPC  │  │ (private only) │  │
│  ┌────────▼───────┐  │         │  └────────────────┘  │
│  │ Node + Play-   │  │         │                      │
│  │ wright (Docker)│──┼─────────┼──► auth + TLS        │
│  └────────────────┘  │         │                      │
│  ┌────────────────┐  │         └──────────────────────┘
│  │ profiles vol.  │  │
│  └────────────────┘  │
└──────────────────────┘
        ▲
        │ HTTPS (yourdomain.com)
       you
```

### Deployment flow

```
Local dev ──► git push ──► GitHub repo
                              │
                              ▼
                       GitHub Actions
                       (build Docker image)
                              │
                              ▼
                    ghcr.io (container registry)
                              │
                              ▼ SSH
                       Scraper VPS
                       (docker compose pull && up -d)
```

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 20 LTS | Playwright's primary language; async-friendly for many concurrent browsers |
| Web framework | Fastify | Modern, fast, clean WebSocket support |
| Browser automation | Playwright | Best multi-browser API; persistent context support |
| Browser | Chromium (bundled with Playwright) | Free, works on Linux, sufficient unless heavy fingerprinting |
| ORM | Mongoose | Schema validation, TTL indexes, mature |
| Database | MongoDB 7 | Flexible schema fits varying scrape outputs |
| Real-time UI | Socket.IO (or native WS) | Push status/logs to dashboard live |
| Auth | JWT + bcrypt | Simple dashboard login |
| Reverse proxy | Caddy | Automatic HTTPS via Let's Encrypt |
| Process manager (host) | Docker / docker compose | Reproducible, isolated |
| CI/CD | GitHub Actions | Free, integrates with GitHub Container Registry |
| Container registry | GitHub Container Registry (ghcr.io) | Free with the repo |
| Frontend | HTMX + plain HTML *(or React)* | Minimal complexity for a personal dashboard |
| VPN / private network | Tailscale | Cross-provider, free for personal, easy |
| OS (production VPS) | Ubuntu 22.04 LTS | Stable, 5-year support, huge ecosystem |

## Project Structure

```
scraper-app/
├── .github/
│   └── workflows/
│       └── deploy.yml          # CI/CD pipeline
├── src/
│   ├── server.js               # Fastify entry point
│   ├── db.js                   # Mongoose connection
│   ├── scraper.js              # Playwright orchestration
│   ├── models/
│   │   ├── Profile.js
│   │   ├── Scrape.js
│   │   └── Log.js
│   ├── routes/
│   │   ├── profiles.js
│   │   ├── scrapes.js
│   │   └── auth.js
│   └── public/
│       └── index.html          # Dashboard UI
├── profiles/                   # Persistent browser data (gitignored)
├── .env                        # Local secrets (gitignored)
├── .env.example                # Template
├── .gitignore
├── .dockerignore
├── Dockerfile
├── docker-compose.yml
├── Caddyfile
├── package.json
└── README.md
```

## Database Schema

### `profiles` collection
Stores one document per logged-in account being managed.

| Field | Type | Description |
|---|---|---|
| `name` | string, unique | Identifier (e.g. `profile1`) |
| `targetUrl` | string | URL to monitor |
| `refreshIntervalMs` | number | Refresh cycle (default 300000 = 5 min) |
| `buttonSelector` | string | CSS selector for the "show data" button |
| `dataSelector` | string | CSS selector for the data rows |
| `status` | enum | `idle` / `logged_in` / `scraping` / `logged_out` / `error` |
| `lastLoginAt` | Date | When the manual login last happened |
| `lastScrapeAt` | Date | When the last successful scrape ran |
| `userDataDir` | string | Path to browser profile folder |
| `proxy` | string (optional) | Proxy URL for this profile |

### `scrapes` collection
One document per scrape attempt.

| Field | Type | Description |
|---|---|---|
| `profileId` | ObjectId, indexed | Reference to profile |
| `scrapedAt` | Date, indexed | Timestamp |
| `data` | Mixed | Scraped data payload |
| `success` | boolean | Did it succeed |
| `errorMessage` | string | Set on failure |

### `logs` collection
Operational log entries. Auto-expires after 30 days via TTL index.

| Field | Type | Description |
|---|---|---|
| `profileId` | ObjectId | Reference to profile |
| `level` | enum | `info` / `warn` / `error` |
| `message` | string | Log text |
| `createdAt` | Date, TTL 30d | Auto-deleted after 30 days |

## Prerequisites

- macOS (for local development)
- Homebrew
- Node.js 20+ (`brew install node`)
- Docker Desktop (`brew install --cask docker`)
- A code editor (VS Code or similar)
- A GitHub account (for deployment later)

## Local Development Setup (MacBook)

### 1. Clone and install

```bash
git clone <your-repo-url> scraper-app
cd scraper-app
npm install
npx playwright install chromium
```

### 2. Start MongoDB in Docker

```bash
docker run -d \
  --name mongo-dev \
  -p 27017:27017 \
  -e MONGO_INITDB_ROOT_USERNAME=root \
  -e MONGO_INITDB_ROOT_PASSWORD=devpassword \
  -v mongo-dev-data:/data/db \
  mongo:7
```

Useful follow-up commands:
- `docker stop mongo-dev` / `docker start mongo-dev` — pause/resume
- `docker logs mongo-dev` — view logs
- `docker rm -f mongo-dev` — remove (data persists in named volume)

Optional: install MongoDB Compass GUI for a visual browser:
```bash
brew install --cask mongodb-compass
```
Connect with `mongodb://root:devpassword@localhost:27017`.

### 3. Configure environment

Copy and edit:
```bash
cp .env.example .env
```

`.env` for local development:
```bash
MONGO_URL=mongodb://root:devpassword@localhost:27017/scraper?authSource=admin
NODE_ENV=development
PORT=3000
HEADLESS=false
JWT_SECRET=any-random-string-for-dev
```

### 4. Run the app

```bash
# With auto-reload during development:
npx nodemon src/server.js

# Or plain:
node src/server.js
```

Open http://localhost:3000 in your browser.

### 5. Initial login for each profile

For each profile you want to set up:
1. Create the profile via the dashboard (provide name, target URL, selectors)
2. Use the "Login" action — a headed Chromium window opens
3. Log in manually with the account's credentials
4. Close the window — session is saved to `profiles/<name>/`
5. Automation begins on the configured interval

## How It Works

### The scraper loop (per profile)

```
launchPersistentContext(profiles/<name>)
       │
       ▼
   open targetUrl
       │
       ▼
┌──► reload page
│      │
│      ▼
│   on login page?  ──── yes ──► mark profile logged_out
│      │ no                       send alert (Telegram/email)
│      ▼                          STOP loop
│   click buttonSelector
│      │
│      ▼
│   waitForSelector(dataSelector)
│      │
│      ▼
│   extract rows
│      │
│      ▼
│   write Scrape doc to MongoDB
│      │
│      ▼
│   emit WebSocket event to dashboard
│      │
│      ▼
└── sleep(refreshIntervalMs + random jitter)
```

### Why persistent context

Playwright's `launchPersistentContext(userDataDir)` stores cookies, localStorage, IndexedDB, and service workers to disk. As long as the target site doesn't aggressively rotate session tokens, the profile stays logged in across restarts, deploys, and even VPS migrations (just move the folder).

### Manual login UX

The dashboard exposes a per-profile "Re-login" action. Two implementation options:

- **CLI fallback**: `npm run login -- --profile profile1` opens a headed browser locally. Simple but requires SSH/RDP access on production.
- **In-dashboard noVNC**: A VNC server attached to a virtual display runs the browser; the dashboard embeds noVNC in a panel. Cleaner — no RDP client ever needed.

The CLI path is the simpler starting point.

## Configuration Reference

All configuration is via environment variables (`.env` file or container env).

| Variable | Description | Example |
|---|---|---|
| `MONGO_URL` | MongoDB connection string | `mongodb://user:pass@host:27017/db` |
| `NODE_ENV` | `development` or `production` | `development` |
| `PORT` | HTTP port for Fastify | `3000` |
| `HEADLESS` | Run browsers headless | `true` / `false` |
| `JWT_SECRET` | Secret for dashboard auth tokens | (random 64-char string) |
| `TELEGRAM_BOT_TOKEN` *(optional)* | For session-expired alerts | — |
| `TELEGRAM_CHAT_ID` *(optional)* | Chat to alert | — |

## Production Deployment (Planned)

### Target environment

Two VPSes (or one to start, separate DB later):

- **Scraper VPS** — Ubuntu 22.04 LTS, 16 GB RAM / 8 vCPU recommended for 10+ profiles
- **Database VPS** *(optional, can start co-located)* — Ubuntu 22.04 LTS, 2–4 GB RAM, NVMe SSD

Suggested providers: Contabo (best value), Vultr (better performance), DigitalOcean (cleanest UX). Pick a Singapore / Mumbai / Tokyo region for low latency from South Asia.

### Containers (on Scraper VPS)

```
docker compose orchestrates:
├── app        (Node + Playwright)
├── mongo      (only present if DB co-located; remove for separate DB VPS)
└── caddy      (TLS + reverse proxy)
```

### Networking between Scraper VPS and DB VPS

- **Tailscale** (recommended): install on both VPSes; MongoDB binds to the Tailscale interface only; no public port exposed.
- **Same-provider VPC**: free private networking between droplets of the same provider.
- **Never** expose MongoDB to the public internet, even with auth enabled.

### CI/CD pipeline

On push to `main`:

1. GitHub Actions builds the Docker image
2. Pushes to `ghcr.io/<user>/scraper-app:latest`
3. SSHs to the scraper VPS, runs:
   ```bash
   docker compose pull
   docker compose up -d
   docker image prune -f
   ```

Required GitHub Actions secrets:

| Secret | Purpose |
|---|---|
| `VPS_HOST` | Scraper VPS IP |
| `VPS_USER` | SSH user (a non-root `deploy` user) |
| `VPS_SSH_KEY` | SSH private key |

### One-time VPS bootstrap

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Create deploy user with docker access
sudo adduser deploy
sudo usermod -aG docker deploy

# Add GitHub Actions public key to /home/deploy/.ssh/authorized_keys

# As deploy user:
git clone <repo>
cd scraper-app
cp .env.example .env   # fill in production values
docker compose up -d
```

### Automatic HTTPS

Caddy obtains and renews Let's Encrypt certificates automatically. Just point an A record at the VPS IP, set the domain in `Caddyfile`:

```
yourdomain.com {
  reverse_proxy app:3000
}
```

## Security Notes

- **MongoDB never on the public internet.** Bind to private/Tailscale interface only.
- **Dashboard behind HTTPS + auth.** Caddy provides TLS; JWT auth gates access.
- **SSH key auth only.** Disable password authentication and root login on the VPS.
- **UFW firewall.** Allow only 22, 80, 443. Block everything else by default.
- **Run app as non-root** inside the container.
- **Rotate secrets** if a VPS is ever compromised; never commit `.env`.
- **Browser profile folders contain session cookies** — treat them as sensitive. Backup encrypted.
- **Respect target site ToS.** Use only on accounts and data you have legal access to. Rate-limit appropriately.

## Backups

Daily MongoDB dump on the DB VPS:

```bash
# /etc/cron.daily/mongo-backup
docker exec scraper-mongo mongodump --archive --gzip \
  -u root -p "$MONGO_PASSWORD" --authenticationDatabase admin \
  > /home/deploy/backups/mongo-$(date +%F).gz
find /home/deploy/backups -name "mongo-*.gz" -mtime +7 -delete
```

Browser profile snapshots (in case sessions are valuable):

```bash
tar czf /home/deploy/backups/profiles-$(date +%F).tar.gz ./profiles
```

Optionally rclone backups to S3/B2/Drive for offsite storage.

## Roadmap

- [ ] Initial scaffold (server, models, scraper loop)
- [ ] Dashboard with profile grid, logs, controls
- [ ] CLI manual-login command
- [ ] Dockerfile + docker-compose for local
- [ ] GitHub Actions deployment workflow
- [ ] Caddy HTTPS in production
- [ ] noVNC in-dashboard remote login
- [ ] Telegram/email alerts on session expiry
- [ ] Per-profile proxy support
- [ ] Migrate to separate DB VPS via Tailscale
- [ ] Daily backups + offsite sync
- [ ] Per-profile retry/backoff configuration
- [ ] Optional: switch from plain Chromium to anti-detect browser (AdsPower / GoLogin) if target site flags fingerprints

## Decision Log

Key architectural choices and why:

- **Linux over Windows** — cheaper hosting, lighter resource use, better automation tooling. RDP-style GUI access is rarely needed once initial logins are done.
- **Plain Chromium + Playwright over anti-detect browser** — free, sufficient for most targets. Upgrade to AdsPower/GoLogin only if fingerprint detection becomes an issue.
- **External script over browser extension** — easier to orchestrate 10+ profiles, central logging, headless mode possible, simpler updates.
- **Web app dashboard over RDP-only access** — accessible from any device, HTTPS-secured, no RDP client required, can embed noVNC for the rare manual logins.
- **Node.js over Python** — Playwright's reference implementation, unified language with frontend, excellent async story for many concurrent browsers.
- **MongoDB over SQL** — flexible schema fits varying scrape outputs; mature Node driver.
- **Docker + Compose over bare installs** — reproducible, easy rollback, identical dev/prod environments.
- **GitHub Actions + ghcr.io over self-hosted CI** — zero infrastructure, free for this scale.
- **Tailscale over public MongoDB with TLS** — smaller attack surface, easier to set up, works across providers.

## License

Private project. All rights reserved.
