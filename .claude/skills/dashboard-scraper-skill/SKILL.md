---
name: dashboard-scraper-skill
description: >-
  Complete reference for the Multi-Profile Browser Scraper Dashboard project
  (Node/Fastify/Playwright/MongoDB). Use when working on this codebase to recall
  architecture, modules, scheduled jobs (cron), exported functions, API routes,
  data models, requirements, run/setup steps, and known hazards (esp. the
  destructive backup-restore). Load before adding features, debugging, or
  starting/operating the server.
---

# Dashboard Scraper — Project Skill

A single-PC system that keeps 20+ authenticated browser sessions alive
(Playwright + real Chrome), scrapes two site layouts (`cgaming`, `zoomwlb`),
archives daily totals to local MongoDB, and serves a web dashboard + Telegram
bot. **All timestamps are forced to Indochina Time (GMT+7, `Asia/Bangkok`).**

Project root: `c:\Users\USER\Documents\scraper-dashboard-main`

---

## 1. Requirements & Run

- **Node.js ≥ 20** (dev machine runs v26.x), **ESM** (`"type": "module"`).
- **Google Chrome** installed (Playwright uses the real `chrome` channel, not bundled Chromium).
- **MongoDB** running locally at `mongodb://127.0.0.1:27017/scraper` (no auth in dev).
- On-disk **`profiles/<name>/`** folders hold each browser's persistent session (cookies/userDataDir). These are NOT in DB backups — losing them means re-login.

**Scripts** (`package.json`):
- `npm start` → `node src/server.js` (production)
- `npm run dev` → `nodemon src/server.js` (watches `src/` + `scripts/` only, to avoid EBUSY on browser locks)
- `npm run login -- <profile-name>` → opens a Chrome window for manual login

Server listens on **`0.0.0.0:3000`** → http://localhost:3000 (dashboard, JWT-cookie gated). `/login` is public.

**Key env** (`.env`, loaded+validated in [config.js](../../../src/config.js)):
`MONGO_URL`, `NODE_ENV`, `PORT`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `JWT_SECRET`, `HEADLESS`, `BROWSER_CHANNEL=chrome`, `TELEGRAM_BOT_TOKEN`.

---

## 2. Architecture & Boot Sequence

[src/server.js](../../../src/server.js) `start()`:
1. `connectDb()` — Mongoose, strictQuery, 10s timeout.
2. Delete legacy `ScheduleSetting` docs missing `key` (pre-singleton cleanup) **before** syncing indexes.
3. `syncIndexes()` on all 5 models.
4. `build()` Fastify (server-level `bodyLimit: 100 MB`), register auth plugin, static, and route groups.
5. `startScheduler()` → `startTelegramBot()` → `startDailyCapture()`.
6. SIGINT/SIGTERM → graceful shutdown: stop jobs, `closeAllContexts()`, `fastify.close()`.

`process.env.TZ` is set to `Asia/Bangkok` at the top of server.js unless already set.

---

## 3. Scheduled / Background Jobs (the "cron")

There is **no OS cron**; all scheduling is in-process via `setTimeout`.

### a) Scraper scheduler — [src/scheduler.js](../../../src/scheduler.js)
Two independent **global** schedules applied to every profile, driven by the
`ScheduleSetting` singleton (`key: 'global'`):
- **fetch** — extract + `saveScrape` to DB. `{enabled, intervalMs}` (default 300000 = 5 min).
- **refresh** — navigate-only keep-alive. `{enabled, intervalMs}`.
- Each interval gets `+ Math.random()*1000` jitter.
- A shared per-profile **running-lock** (`running` Set) prevents fetch/refresh colliding on the same browser context; if busy at tick time, it just reschedules.
- On `result.loggedIn === false`: set status `logged_out`, log warn, and fire `sendSessionAlert(profile, source)` **only on the transition** (`!wasOut`) so alerts don't spam.
- Exports: `startScheduler(log)`, `stopScheduler()`, `rescheduleAll()`, `reschedule(profileId)`, `applySettings(next)`, `getSnapshot()`.

### b) Daily yesterday-archive — [src/dailyCapture.js](../../../src/dailyCapture.js)
- Fires at **00:15 ICT** every day (`CAPTURE_HOUR=0`, `CAPTURE_MIN=15`), self-rescheduling via `msUntilNext`.
- Plus a **startup catch-up** ~15 s after boot: `captureYesterdayAll({ onlyMissing: true })` fills any profile missing yesterday (so restarts don't re-scrape).
- Captures yesterday for **both** `zoomwlb` and `cgaming` profiles, `GAP_MS=1500` between profiles to avoid a launch storm; upserts one row per `(profileId, reportDate)`.
- Session-expired profiles are skipped + alerted (transition-only).
- Exports: `captureYesterdayAll({onlyMissing})`, `startDailyCapture(logger)`, `stopDailyCapture()`.

### c) Telegram long-poll bot — [src/telegram.js](../../../src/telegram.js)
Continuous long-polling loop (not timer-based). See §6.

### d) Context pool reaper — [src/contextPool.js](../../../src/contextPool.js)
Keeps one reusable `BrowserContext` per profile; auto-closes contexts idle > 30 min.

---

## 4. Data Models (collections)

| Collection | Model | Key fields |
|---|---|---|
| `profiles` | [Profile.js](../../../src/models/Profile.js) | `name`(unique), `kind`(cgaming\|zoomwlb), `loginUrl`, `targetUrl`, `refreshIntervalMs`(≥10000, def 300000), `buttonSelector`, `dataFields[{id,label}]`, `status`(idle\|logged_in\|scraping\|logged_out\|error), `lastLoginAt`, `lastScrapeAt`, `userDataDir`, `proxy`, `notes`, timestamps |
| `scrapes` | [Scrape.js](../../../src/models/Scrape.js) | `profileId`, `kind`, `reportDate`(midnight-aligned key), `reportDateString`, `data`(common schema), `raw`, `tables[]`, `scrapedAt`. **One canonical row per (profileId, reportDate)** via upsert. |
| `schedulesettings` | [ScheduleSetting.js](../../../src/models/ScheduleSetting.js) | Singleton `key:'global'`; `fetch{enabled,intervalMs}`, `refresh{enabled,intervalMs}`. `getSettings()`, `updateSettings()`. |
| `telegramsettings` | [TelegramSetting.js](../../../src/models/TelegramSetting.js) | Singleton; `restricted`, `allowedChatIds[]`, `allowedUsernames[]`, `sendImage`, `sendText`, `alertChatIds[]`. Helpers: `getTelegramSettings`, `updateTelegramSettings`, `add/removeChatId`, `add/removeAlertChatId`, `add/removeUsername`, `isAllowed`, `normalizeUsername`. |
| `activitylogs` | [ActivityLog.js](../../../src/models/ActivityLog.js) | `actorType`(admin\|telegram\|system), `actor`, `action`, `target`, `details`, `meta`, `createdAt`. |

**Common data schema** ([parsers/common.js](../../../src/parsers/common.js)) — 6 numeric metrics shared by both site kinds: `newRegistrationCount`, `newDepositCount`, `totalDepositCount`, `totalDepositAmount`, `totalWithdrawalCount`, `totalWithdrawalAmount`.

---

## 5. Scrape pipeline & parsers

[src/scrapeRunner.js](../../../src/scrapeRunner.js) — splits read-only fetch+parse from save:
- `runAndParse(profile, {headless, log, period})` → `{result, parsed}`, never saves. `period: 'today' | 'yesterday'`. `result.loggedIn === false` ⇒ session gone.
- `saveScrape(profile, parsed, result)` → upsert by `(profileId, reportDate)`; idempotent.
- `fetchYesterday(profile)` → **DB-first**: archive hit returns instantly (`cached:true`, no browser); miss scrapes live + stores.
- `yesterdayReportDate()` → midnight-ICT of yesterday (the lookup key).

Site parsers:
- **cgaming** [parsers/cgaming.js](../../../src/parsers/cgaming.js): `findBankSummaryTable(tables)`, `parseBankSummary(table, {now})` — picks the table row whose date matches `now` (so passing a yesterday `now` yields yesterday's row). No dedicated "yesterday view"; both days live in one table.
- **zoomwlb** [parsers/zoomwlb.js](../../../src/parsers/zoomwlb.js): `parseZoomwlb(fields, {now})` — reads fixed HTML element ids; **all periods coexist** on the page in separate ids (`todayNewPlayer` / `yesterdayNewPlayer`, …). `zoomwlbFieldIds(period)` in common.js returns the right id set. Amount fields scaled ×1000.

Browser layer [src/scraper.js](../../../src/scraper.js): `openContext`, `runFetch(profile, context, {log, period})`, `runRefresh`, `persistCookies`, `fetchProfileData`, `PROFILES_ROOT`.

---

## 6. Telegram bot — [src/telegram.js](../../../src/telegram.js)

- Long-polling via raw `fetch` (no SDK). `startTelegramBot(logger)`, `stopTelegramBot()`, `getBotInfo()`.
- Flow: `/start` → profile-list buttons (alphabetical) → tap profile → today/yesterday → replies with a **styled PNG card** ([imageRender.js](../../../src/imageRender.js) `renderProfileCard`) and/or a **text summary**, gated by `sendImage`/`sendText`.
- Access control: if `restricted`, only `allowedChatIds` / `allowedUsernames` (`isAllowed`).
- **Session-expired alerts**: `sendSessionAlert(profile, source)` iterates `alertChatIds` (multiple recipients); `sendTestAlert()` for the Settings "test" button. A bad/unknown chat id yields `chat not found` for that id only — others still receive.

---

## 7. HTTP API (all under `/api`, JWT-cookie gated except auth/login)

- **auth** [routes/auth.js](../../../src/routes/auth.js): `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
- **profiles** [routes/profiles.js](../../../src/routes/profiles.js): `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`, `POST /:id/login`, `POST /:id/login/finish`, `POST /:id/login/cancel`, `POST /:id/fetch` (today/yesterday).
- **settings** [routes/settings.js](../../../src/routes/settings.js): `GET/PATCH /scheduler`; `GET/PATCH /telegram`; `POST/DELETE /telegram/chat-ids`; `POST/DELETE /telegram/alert-chats`; `POST /telegram/test-alert`; `POST/DELETE /telegram/usernames`.
- **logs** [routes/logs.js](../../../src/routes/logs.js): `GET /api/logs/stream` (SSE live log from in-memory ring buffer, 200 events — [logBroker.js](../../../src/logBroker.js): `logEvent`, `getRecent`, `subscribe`).
- **activity** [routes/activity.js](../../../src/routes/activity.js): `GET /api/activity` (paginated audit trail, filter by `actorType`). Recorder: [activityLog.js](../../../src/activityLog.js) `recordActivity` (fire-and-forget), `getActivity`.
- **backup** [routes/backup.js](../../../src/routes/backup.js): `GET /api/backup/` (download EJSON), `POST /api/backup/restore` (route `bodyLimit: 50 MB`).

Frontend: vanilla JS in [public/app.js](../../../src/public/app.js), [public/index.html](../../../src/public/index.html), [public/login.html](../../../src/public/login.html), [public/style.css](../../../src/public/style.css).

---

## 8. Backup & Restore — ⚠️ HAZARD

[src/backup.js](../../../src/backup.js):
- `exportAll()` → EJSON string (`relaxed:false`, so ObjectId/Date round-trip) of all 5 collections in order: `schedulesettings, telegramsettings, profiles, scrapes, activitylogs`. `BACKUP_VERSION = 1`.
- `restoreAll(parsedBody)` → `EJSON.deserialize`, validates `version` + presence of `collections`, then **per collection `deleteMany({})` then raw `insertMany`**.

**DANGER:** `restoreAll` will wipe every collection even when the uploaded backup
has **empty or missing** collection arrays — there is no "non-empty" guard. A body
like `{"version":1,"collections":{}}` deletes everything and inserts nothing.
This already caused a full production wipe once (24 profiles, 5553 scrapes, 349
activity logs, both settings singletons). Session folders on disk survived.

**Rules when touching this code:**
- **Never** test restore against the live DB with a hand-made/empty body.
- Harden `restoreAll` to **refuse** when a collection array is empty/missing (skip, don't wipe), and ideally back up before replacing.
- Browser `profiles/<name>/` session folders are NOT in backups; preserve `_id`s on profile restore so existing session folders stay linked.

---

## 9. Conventions & gotchas

- **Plan-first**: for non-trivial work, explain the approach and confirm before coding.
- **Timezone**: everything is GMT+7; new date logic must format/compare in `Asia/Bangkok`, not host-local assumptions.
- **PowerShell** on this box: `Invoke-WebRequest` POST needs explicit `-ContentType "application/json" -Body ...` or it sends form-urlencoded → 415.
- **nodemon** watch is scoped to `src/`+`scripts/` on purpose — don't widen it or browser profile locks cause EBUSY restart loops.
- Idempotency: scrapes upsert by `(profileId, reportDate)`; re-running a day overwrites rather than duplicating.
- Alerts fire only on `logged_in → logged_out` transitions (`!wasOut`), never repeatedly.
