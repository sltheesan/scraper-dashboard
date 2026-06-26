# VPS Deployment Plan — Scraper Dashboard

Goal: run the dashboard on a cloud VPS for testing, **without stopping or
endangering the copy running on this PC**, and **without ever repeating the data
wipe**. Decisions captured from planning:

- **MongoDB:** native on the VPS (NOT dockerized) — same as the PC. Easier
  server-to-server data migration later.
- **App:** dockerized, single container, `network_mode: host` so
  `MONGO_URL=mongodb://127.0.0.1:27017/scraper` is identical to the PC.
- **Sessions:** `profiles/` is a **plain host directory, bind-mounted** into the
  container (not a Docker volume) → portable, easy to copy.
- **Config:** `.env` is a host file passed via `env_file`.
- **Isolation:** the cloud has its own DB + its own `profiles/`. It never
  connects to this PC. This PC keeps running untouched throughout.
- **Login on VPS:** via the in-container virtual desktop (Xvfb + noVNC),
  auth-gated by Caddy.

Target host layout:
```
/opt/scraper/
├── profiles/   ← host dir → bind-mounted to /app/profiles (browser sessions)
└── .env        ← host file → env_file (config/secrets)
MongoDB         ← native service on the VPS, 127.0.0.1:27017
```

---

## Phase 0 — Safety fix FIRST (code, on a branch) — before any cloud move

> Root cause of the earlier wipe was the app-level restore, not the DB engine.
> Docker/volumes do NOT protect against it. Fix this before data moves anywhere.

1. [ ] Create a working branch (e.g. `feat/vps-deploy`).
2. [ ] Harden `restoreAll` in [src/backup.js](src/backup.js): if a collection's
   array in the uploaded backup is **empty or missing**, **skip** it (do not
   `deleteMany`). Never blank a collection from an empty/garbage file.
3. [ ] Auto-snapshot before replace: dump each collection to a timestamped file
   on disk immediately before the restore writes to it.
4. [ ] Add a `mongodump`-based backup script (authoritative, DB-level, separate
   from the app's JSON export) + a documented restore-from-dump command.
5. [ ] Test Phase 0 against a **throwaway** local DB only — never the live one.
6. [ ] Confirm this PC's DB is healthy/populated before treating it as a source.

## Phase 1 — Provision the VPS

7. [ ] Spin up a Linux VPS (Ubuntu LTS), **8 GB+ RAM** (20+ Chrome sessions are
   heavy), with a persistent disk.
8. [ ] Create `/opt/scraper/profiles` and `/opt/scraper/.env` on the host.
9. [ ] Install Docker + Docker Compose plugin.

## Phase 2 — MongoDB native on the VPS

10. [ ] Install MongoDB Community natively (same major version as the PC).
11. [ ] Bind it to `127.0.0.1` only; confirm `mongodb://127.0.0.1:27017/scraper`
    responds. Do **not** expose 27017 to the internet.
12. [ ] (Optional) enable auth; if so, update `MONGO_URL` accordingly.

## Phase 3 — Dockerize the app (single container)

13. [ ] Write a `Dockerfile` based on a Playwright image: Node 20 + Chrome +
    `Xvfb`, `fluxbox`, `x11vnc`, `websockify`/`noVNC`, `supervisord`. Reuse
    [docker/supervisord.conf](docker/supervisord.conf) (app launches Chrome on
    `DISPLAY=:99`).
14. [ ] Write `docker-compose.yml`:
    - `network_mode: host` (so container reaches native Mongo at 127.0.0.1)
    - `volumes: [ /opt/scraper/profiles:/app/profiles ]`
    - `env_file: /opt/scraper/.env`
    - `restart: unless-stopped`
15. [ ] Populate `/opt/scraper/.env`: strong `JWT_SECRET`, `ADMIN_PASSWORD`,
    `HEADLESS=true`, `BROWSER_CHANNEL=chrome`, and a **separate test Telegram
    bot token** (or blank). See Phase 5 note.
16. [ ] `docker compose build && docker compose up -d`; verify the app boots and
    connects to Mongo.

## Phase 4 — Reverse proxy + the noVNC login screen

17. [ ] Put Caddy in front for HTTPS (dashboard) and to **auth-gate noVNC**
    (`forward_auth`), so the virtual desktop isn't publicly exposed.
18. [ ] Confirm: dashboard reachable over HTTPS; noVNC reachable only after auth.

## Phase 5 — Seed profiles + log in (data-safe)

19. [ ] Recreate the profile configs on the cloud (fresh start) **or** import
    config from this PC using the **hardened** export into the **empty** cloud DB.
20. [ ] For each profile: dashboard → **Login** → open noVNC → complete login in
    the headed Chrome window → **Save**. Cookies persist to
    `/opt/scraper/profiles/<name>/`.
21. [ ] **Telegram conflict guard:** a bot token can only be long-polled by ONE
    process. The cloud MUST use a **different** token from the PC (or leave it
    blank) — otherwise both bots break with 409 conflicts.

## Phase 6 — Validate on cloud (PC still running untouched)

22. [ ] End-to-end on one profile: fetch today → yesterday archive → a scheduler
    tick → dashboard view → (optional) test-bot message.
23. [ ] Confirm the daily 00:15 ICT capture and the fetch/refresh schedules run.
24. [ ] Confirm this PC was never affected (separate DB, separate sessions).

## Phase 7 — Migration / cutover (LATER, optional)

25. [ ] To move data between servers: `mongodump` the DB **and** copy the
    `/opt/scraper/profiles/` folder together; restore on the target.
26. [ ] Some profiles may re-challenge after an IP/machine change → quick noVNC
    re-login. DB data migrates cleanly; only sessions might need it.

---

## Data-safety rules (do not violate)

- **Never** `docker compose down -v` and **never** `docker volume rm` — but note
  Mongo is native here, so the real data lives on the host filesystem anyway.
- **Never** test restore against a live/populated DB with a hand-made or empty
  backup file. (This is what caused the original wipe.)
- Keep a fresh `mongodump` before any restore or migration.
- Cloud and PC **share nothing** — separate DB, separate `profiles/`, separate
  Telegram bot token.
