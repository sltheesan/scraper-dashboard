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

# Create a non-root deploy user
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh

# Add your GitHub Actions deploy key's PUBLIC key:
echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIqp6oCPnneZUOmKYNJpiPrevPAKuUQSn4PBpe4cw+nt sltheesan@gmail.com github-deploy" > /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys

# Install Docker
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy

# Disable password SSH + root login
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart ssh
```

From now on, SSH in as `deploy@your-vps-ip`.

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
fjdks
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

## 5. Files You'll Need to Add (when ready to deploy)

Currently missing from the repo:

| File | Purpose |
|---|---|
| `Dockerfile` | Builds the app image with Node 20 + Playwright |
| `docker-compose.yml` | Production: `app` + `mongo` + `caddy` services |
| `Caddyfile` | Reverse proxy + automatic HTTPS |
| `.github/workflows/deploy.yml` | CI/CD pipeline |
| `.dockerignore` | Skip `node_modules`, `profiles`, `.env`, `.git` |

Each is ~30–60 lines. None blocks you from starting the workflow above —
they're generated when you're ready to go live.

---

## 6. GitHub Actions Shape

Two-stage workflow:

```
push to main
   │
   ▼
┌──────────────────────────────────────┐
│  Job 1: build-and-push               │
│   - checkout                         │
│   - log in to ghcr.io                │
│   - docker build .                   │
│   - docker tag :latest + :sha        │
│   - docker push                      │
└──────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────┐
│  Job 2: deploy                       │
│   - ssh deploy@$VPS_HOST             │
│   - cd /home/deploy/scraper-app      │
│   - docker compose pull              │
│   - docker compose up -d             │
│   - docker image prune -f            │
└──────────────────────────────────────┘
```

**Secrets in GitHub repo settings → Actions → Secrets:**

| Name | Value |
|---|---|
| `GHCR_TOKEN` | A GitHub PAT with `write:packages` |
| `VPS_HOST` | The VPS IP |
| `VPS_USER` | `deploy` |
| `VPS_SSH_KEY` | The PRIVATE key whose public half is in `authorized_keys` |

The image lives at `ghcr.io/<you>/scraper-app:latest` — free with the repo,
no Docker Hub needed.

---

## 7. Production File Layout on the VPS

```
/home/deploy/scraper-app/
├── docker-compose.yml          ← only file you place by hand (or git clone the repo here)
├── Caddyfile
├── .env                        ← production secrets, NEVER in git
├── backups/                    ← daily mongodump output (kept ~7 days)
└── volumes/
    ├── profiles/               ← persistent browser data (survives deploys)
    ├── mongo_data/             ← MongoDB data files (survives deploys)
    └── caddy_data/             ← Let's Encrypt certs
```

`docker compose pull && up -d` replaces the app container but **keeps all
`volumes/*` mounts** — your Chrome sessions and Mongo data survive deployments.

### Docker network

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

`mongo` is reachable from `app` as `mongodb://mongo:27017` and **not from the
public internet**. No port for Mongo is published in `docker-compose.yml`.

---

## 8. The Trickiest Bit: Manual Login on a Headless VPS

The Login button in the dashboard opens a *visible* Chrome window. That works
on your Mac. On a headless VPS, there's no display.

Three options, pick one:

| Option | Effort | UX |
|---|---|---|
| **A. Log in locally → copy `profiles/` to VPS** | Lowest | One-time per profile; manual via `scp` |
| **B. Run Xvfb + noVNC on the VPS** | Medium | Click Login in dashboard, embedded noVNC iframe shows the browser. Cleanest long-term. |
| **C. Run app locally just for login, then sync** | Lowest | Same as A but automated as a script |

Start with **A** — fastest to ship. Move to **B** later when you're tired of
`scp`.

For A:

```bash
# After logging in locally to all profiles:
rsync -avz --delete ./profiles/ deploy@$VPS:/home/deploy/scraper-app/volumes/profiles/
```

---

## 9. Production `.env` (changes vs. dev)

```bash
NODE_ENV=production
PORT=3000
# Internal Docker DNS — 'mongo' resolves to the Mongo container on the
# private network; never exposed to the public internet.
MONGO_URL=mongodb://root:STRONG_PASSWORD@mongo:27017/scraper?authSource=admin
ADMIN_USERNAME=...                 # consider a stronger password than dev
ADMIN_PASSWORD=...
JWT_SECRET=...                     # generate fresh: long random
HEADLESS=true                      # invisible Chrome
BROWSER_CHANNEL=chrome             # use installed Chrome

# Mongo container reads these to initialise its root user on first boot:
MONGO_INITDB_ROOT_USERNAME=root
MONGO_INITDB_ROOT_PASSWORD=STRONG_PASSWORD
```

The same `STRONG_PASSWORD` must appear in both `MONGO_URL` and
`MONGO_INITDB_ROOT_PASSWORD`. Generate one fresh:

```bash
openssl rand -base64 32
```

### Backups

A daily `cron` job on the VPS dumps the database and prunes anything older
than 7 days:

```bash
# /etc/cron.daily/mongo-backup  (chmod +x)
docker exec scraper-mongo mongodump --archive --gzip \
  -u root -p "$MONGO_PASSWORD" --authenticationDatabase admin \
  > /home/deploy/scraper-app/backups/mongo-$(date +%F).gz
find /home/deploy/scraper-app/backups -name "mongo-*.gz" -mtime +7 -delete
```

Optional: `rclone` the `backups/` directory to S3 / Backblaze B2 / Google
Drive for offsite copies.

---

## 10. Full End-to-End Deploy Flow

```
You on Mac:                       GitHub:                       VPS:
─────────────                     ───────                       ────

git push main  ───────────────►   Actions workflow fires
                                          │
                                          ▼
                                  Build Docker image
                                          │
                                          ▼
                                  Push to ghcr.io
                                          │
                                          ▼
                                  SSH to VPS, run:        ───►  docker compose pull
                                                                docker compose up -d
                                                                docker image prune

                                                                ▼
                                                          Caddy keeps HTTPS,
                                                          app reloads with new code,
                                                          browser profiles intact,
                                                          scheduler resumes
```

You watch GitHub Actions go green (~3–5 min total). Open
`https://yourdomain.com` → dashboard live.

---

## 11. Before You Start — Decisions to Make

1. **VPS provider + region** (§1) — pick one
2. **Domain name** — needed for HTTPS (Caddy auto-issues Let's Encrypt). ~$10/yr. Buy from Cloudflare or Namecheap.
3. **Login strategy** — A, B, or C from §8
4. **GitHub repo visibility** — private (recommended)
5. **Optional: Tailscale** — useful later if you ever want to bind MongoDB or SSH only to a private network instead of public IPs

---

## 12. What to Provide When You're Ready

Send back:

- VPS choice (e.g. "Hetzner CX31 in Singapore")
- The domain name
- Your login strategy (A / B / C)

Then the following will be generated and committed in one go:

- `Dockerfile`
- `docker-compose.yml`
- `Caddyfile`
- `.dockerignore`
- `.github/workflows/deploy.yml`
