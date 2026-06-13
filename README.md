# Multi-Profile Browser Scraper

A self-hosted system that keeps multiple authenticated browser sessions alive, scrapes their dashboards on demand and on a schedule, stores daily results in MongoDB, and exposes everything through a web dashboard **and** a Telegram bot.

Runs locally on a single PC — no Docker, no VPS, no CI/CD.

## Overview

Some back-office sites require login, idle-timeout their sessions, and only show data after interacting with the page. Keeping 20+ accounts logged in and pulling their numbers by hand is impractical. This app automates it:

1. Manages many persistent browser **profiles** (one per logged-in account).
2. Keeps sessions alive with a periodic page **refresh**.
3. **Fetches** each profile's metrics — on demand (dashboard/Telegram) or on a schedule.
4. **Archives** yesterday's completed numbers to MongoDB once a day.
5. Serves a **dashboard** (status, search/filter, live activity log) and a **Telegram bot** (tap a profile → get its data as a styled image card and/or text).

Two site layouts are supported out of the box via typed parsers: **cgaming** (a daily-report table) and **zoomwlb** (a dashboard of summary widgets). Both normalize to one common schema.

## Features

- **Persistent sessions** — cookies/storage survive restarts via Playwright's `launchPersistentContext`, plus a saved cookie file per profile.
- **Manual login** — click **Login** on a profile (a real Chrome window opens on this PC), sign in, then **Save session**. Or use `npm run login -- <name>`.
- **Today & Yesterday** — *today* is fetched live; *yesterday* is served instantly from the DB archive (with a live-scrape fallback if not yet stored).
- **Daily archive** — a job at **00:15 ICT** (plus a startup catch-up) stores each profile's completed *yesterday* — one row per profile per day.
- **Two schedulers** — a periodic **fetch** (scrape + save today) and a periodic **refresh** (keep sessions alive), both configurable in the dashboard.
- **Datatable dashboard** — search, kind/status filters, pagination, alphabetical ordering, live activity log (SSE).
- **Telegram bot** — lists profiles as buttons, fetches Today/Yesterday, replies with a rendered **image card** and/or text (toggable), with an allowlist by **chat ID or `@username`**.
- **Common schema** — every parser outputs the same six metrics, so the UI/bot/storage are uniform.
- **Indochina Time (GMT+7)** everywhere, regardless of the host clock.

## How it works

### Fetch pipeline

```
acquire pooled browser context  (contextPool.js)
        │
        ▼
   open targetUrl  ──► on a login page?  ── yes ──► mark logged_out
        │ no
        ▼
   click buttonSelector (if any)         (cgaming uses #search)
        │
        ▼
   extract per kind:
     • cgaming → pick the bank-summary table ROW for the day (today/yesterday)
     • zoomwlb → read the today* / yesterday* element ids on the page
        │
        ▼
   parse → common schema  (parsers/*.js)
        │
        ▼
   return preview  (manual/Telegram)  OR  saveScrape() upsert  (scheduler/archive)
```

- **Today** is always scraped live (it's still counting up).
- **Yesterday** is immutable. The dashboard/bot read it from the `scrapes` archive first (instant); on a miss they scrape it live once and store it.

### Daily yesterday-capture

`dailyCapture.js` runs at **00:15 ICT** and ~15s after startup (catch-up, only filling missing days). It scrapes each profile's yesterday and upserts one canonical row keyed by `(profileId, reportDate)`. Logged-out profiles are skipped and logged.

### Why persistent context

`launchPersistentContext(profiles/<name>)` keeps cookies/localStorage/IndexedDB on disk, so a profile stays logged in across restarts. Cookies are also dumped to `profiles/<name>/session-cookies.json` (session-only cookies get an extended expiry) and re-injected on each fetch.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+ (ESM) |
| Web framework | Fastify 4 |
| Browser automation | Playwright (Chromium via installed Google **Chrome** channel) |
| Database / ODM | MongoDB + Mongoose 8 |
| Auth | JWT in an HttpOnly cookie (`@fastify/jwt` + `@fastify/cookie`) |
| Live updates | Server-Sent Events (in-memory log broker) |
| Frontend | Plain HTML + CSS + vanilla JS (no build step) |
| Telegram | Bot API via long polling (no dependency — raw `fetch`) |
| Image cards | Playwright headless render of an HTML template → PNG |
| Dev reload | nodemon (watches `src/` + `scripts/` only) |

## Project structure

```
scraper-dashboard/
├── src/
│   ├── server.js          # Fastify entry; sets TZ=ICT; boots scheduler, bot, daily capture
│   ├── config.js          # env config + validation
│   ├── db.js              # Mongoose connection
│   ├── scraper.js         # Playwright: openContext, runFetch, runRefresh, cookie persistence
│   ├── scrapeRunner.js    # runAndParse, saveScrape (upsert/day), fetchYesterday (DB-first)
│   ├── scheduler.js       # periodic fetch + refresh jobs
│   ├── dailyCapture.js    # 00:15 ICT yesterday archive + startup catch-up
│   ├── contextPool.js     # one reusable browser context per profile
│   ├── logBroker.js       # in-memory ring buffer + SSE for the activity log
│   ├── telegram.js        # long-poll bot: profile list, today/yesterday, image/text
│   ├── imageRender.js     # HTML → PNG stat-card renderer
│   ├── models/            # Profile, Scrape, ScheduleSetting, TelegramSetting
│   ├── parsers/           # common (schema + zoomwlb ids), cgaming, zoomwlb
│   ├── plugins/auth.js    # JWT cookie auth decorator
│   ├── routes/            # auth, profiles, settings, logs
│   └── public/            # index.html, app.js, style.css, login.html
├── scripts/login.js       # CLI manual login: npm run login -- <name>
├── profiles/              # persistent browser data per profile (gitignored)
├── .env / .env.example
└── package.json
```

## Data model

### `profiles`
| Field | Type | Notes |
|---|---|---|
| `name` | string, unique | letters/numbers/`_`/`-`; also the profile folder name |
| `kind` | enum | `cgaming` \| `zoomwlb` (controls parsing) |
| `loginUrl` | string | where you log in |
| `targetUrl` | string | page to scrape after login |
| `buttonSelector` | string | optional click before scraping (cgaming: `#search`) |
| `dataFields` | `[{id,label}]` | optional generic field map (non-zoomwlb) |
| `refreshIntervalMs` | number | default 300000 |
| `status` | enum | `idle`/`logged_in`/`scraping`/`logged_out`/`error` |
| `lastLoginAt`, `lastScrapeAt` | Date | |
| `userDataDir` | string | derived from `name` |
| `proxy`, `notes` | string | optional |

### `scrapes`
One canonical row per `(profileId, reportDate)`, upserted.

| Field | Type | Notes |
|---|---|---|
| `profileId` | ObjectId, indexed | |
| `kind` | string | |
| `reportDate` | Date, indexed | midnight (ICT) of the day the data is for |
| `reportDateString` | string | original period text (cgaming) / ISO (zoomwlb) |
| `data` | object | the common schema (see below) |
| `raw` | object | original cells, for audit |
| `tables` | array | tables captured on the fetch |
| `scrapedAt` | Date, indexed | |

### Common schema (`data`)
`newRegistrationCount`, `newDepositCount`, `totalDepositCount`, `totalDepositAmount`, `totalWithdrawalCount`, `totalWithdrawalAmount`.

### Singleton settings
- **`schedulesettings`** — `fetch{enabled,intervalMs}`, `refresh{enabled,intervalMs}`.
- **`telegramsettings`** — `restricted`, `allowedChatIds[]`, `allowedUsernames[]`, `sendImage`, `sendText`.

> The activity log is **in-memory** (ring buffer + SSE), not a database collection.

## Prerequisites (Windows)

- **Node.js 20+**
- **Google Chrome** installed (the app launches the real Chrome channel)
- **MongoDB Community Server** running locally (default `127.0.0.1:27017`)
- Optional: `mongosh` for inspecting the database

## Setup & run

```powershell
# 1. Install dependencies
npm install
# (Chrome channel is used by default. To use Playwright's bundled Chromium
#  instead, set BROWSER_CHANNEL= empty in .env and run:)
# npx playwright install chromium

# 2. Configure environment
copy .env.example .env   # then edit values

# 3. Run
npm run dev   # auto-reload (nodemon)
# or: npm start
```

Open **http://localhost:3000** and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

### First-time login per profile
1. Create a profile in the dashboard (name, kind, login URL, target URL, button selector).
2. Click **Login** → a Chrome window opens on this PC → sign in → click **Save session**.
3. The session is stored in `profiles/<name>/`; fetches now work.

> PowerShell note: if `npm` is blocked by execution policy, run once:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Configuration (.env)

| Variable | Description |
|---|---|
| `MONGO_URL` | e.g. `mongodb://127.0.0.1:27017/scraper` |
| `NODE_ENV` | `development` / `production` |
| `PORT` | dashboard port (default 3000) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | dashboard login |
| `JWT_SECRET` | long random string for signing auth cookies |
| `HEADLESS` | `true` (default) runs scrape fetches invisibly; `false` shows the browser |
| `BROWSER_CHANNEL` | `chrome` (default) or empty to use bundled Chromium |
| `TELEGRAM_BOT_TOKEN` | from @BotFather; leave blank to disable the bot |
| `TZ` *(optional)* | defaults to `Asia/Bangkok` (GMT+7) if unset |

## Dashboard

- **Profiles table** — search (name/URL), filter by kind/status, pagination, alphabetical order.
- Per-profile actions: **Login**, **Fetch** (today), **Yesterday**, **Edit**, **Delete**.
- **Activity** — live SSE log of fetches, refreshes, captures, and Telegram/bot events.
- **Settings** — enable/tune the **fetch** and **refresh** schedules.
- **Telegram** — bot status, reply format (image/text), access restriction, and the allowed users list.

## Telegram bot

1. Create a bot with **@BotFather**, put the token in `.env` (`TELEGRAM_BOT_TOKEN`), restart.
2. Message the bot → it replies with your profiles as buttons.
3. Tap a profile → **🔄 Today** / **📅 Yesterday** → it replies with a styled image card and/or text summary.

**Access control** (dashboard → Telegram):
- Turn **Restrict access** on, then add allowed entries — either a numeric **chat ID** or an **`@username`** (matched case-insensitively). The bot tells an unauthorized user their own chat ID and username so you can add them.
- Caveat: a `@username` can be changed by its owner; a chat ID never changes.

## Timezone

All timestamps and the cgaming/zoomwlb day boundaries use **Indochina Time (GMT+7)**. The server forces `TZ=Asia/Bangkok` and the dashboard/bot format explicitly in that zone, so output is correct even if the host clock is set elsewhere.

## Security notes

- `.env`, `profiles/`, and scratch notes are gitignored. **Profile folders contain live session cookies — treat them as secrets.**
- The dashboard is gated by JWT cookie auth; keep `JWT_SECRET` private and use a strong `ADMIN_PASSWORD`.
- Keep the Telegram bot **restricted** to your own chat ID / username.
- Respect each target site's terms; only use accounts and data you're authorized to access, and keep request rates reasonable.

## License

Private project. All rights reserved.
