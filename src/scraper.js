import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { ZOOMWLB_FIELD_IDS } from './parsers/common.js';

export const PROFILES_ROOT = path.resolve('profiles');
const COOKIE_FILE = 'session-cookies.json';
const PERSIST_LIFETIME_SECS = 30 * 24 * 3600; // 30 days

function profileDir(profile) {
  return profile.userDataDir || path.join(PROFILES_ROOT, profile.name);
}

function cookieFilePath(profile) {
  return path.join(profileDir(profile), COOKIE_FILE);
}

/**
 * Save the current cookies for the profile to disk, extending session-only
 * cookies (those without an `expires`) so they survive a browser restart.
 */
export async function persistCookies(profile, context) {
  const cookies = await context.cookies();
  const now = Math.floor(Date.now() / 1000);
  const persisted = cookies.map((c) => {
    if (!c.expires || c.expires < 0) {
      return { ...c, expires: now + PERSIST_LIFETIME_SECS };
    }
    return c;
  });
  await fs.mkdir(profileDir(profile), { recursive: true });
  await fs.writeFile(cookieFilePath(profile), JSON.stringify(persisted, null, 2));
  return persisted.length;
}

/**
 * Load saved cookies for the profile and inject them into a context.
 * Returns the number of cookies restored, or 0 if no file exists.
 */
async function restoreCookies(profile, context) {
  try {
    const raw = await fs.readFile(cookieFilePath(profile), 'utf8');
    const cookies = JSON.parse(raw);
    if (Array.isArray(cookies) && cookies.length) {
      await context.addCookies(cookies);
      return cookies.length;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return 0;
}

// Use a stable, realistic Chrome UA in both headed and headless modes so the
// session cookies stored during login remain valid for headless fetches.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function ensureProfileDir(profile) {
  const dir = profileDir(profile);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function launchOpts(profile) {
  const opts = {};
  if (profile.proxy) opts.proxy = { server: profile.proxy };
  return opts;
}

/**
 * Open a persistent browser context for the profile.
 * Caller is responsible for closing the returned context.
 */
export async function openContext(profile, { headless = true } = {}) {
  const userDataDir = await ensureProfileDir(profile);
  const launchOptions = {
    headless,
    viewport: { width: 1366, height: 850 },
    userAgent: USER_AGENT,
    locale: 'en-US',
    args: [
      // Hide the obvious automation flags some sites check for.
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    ...launchOpts(profile),
  };

  // Prefer installed Chrome over Playwright's bundled chromium-headless-shell.
  // Real Chrome in headless mode has full feature parity and isn't detected
  // by sites that fingerprint headless-shell. Override with
  // BROWSER_CHANNEL='' (empty) in .env to fall back to bundled chromium.
  const channel = process.env.BROWSER_CHANNEL ?? 'chrome';
  if (channel) launchOptions.channel = channel;

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);

  // Patch out navigator.webdriver before any page script runs.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  return context;
}

/**
 * Heuristic: are we on a login page?
 * True if the URL changed away from targetUrl, or a password input is visible.
 */
async function looksLikeLoginPage(page, targetUrl) {
  try {
    const currentUrl = page.url();
    const targetHost = new URL(targetUrl).host;
    const currentHost = new URL(currentUrl).host;
    if (currentHost !== targetHost) return true;
    const currentPath = new URL(currentUrl).pathname.toLowerCase();
    const targetPath = new URL(targetUrl).pathname.toLowerCase();
    if (currentPath !== targetPath && /login|signin|auth/.test(currentPath)) {
      return true;
    }
    const hasPassword = await page.locator('input[type="password"]').first().isVisible().catch(() => false);
    return hasPassword;
  } catch {
    return false;
  }
}

/**
 * Extract every <table> in a single frame as { headers, rows }.
 * Headers come from <thead th> if present, else from the first row's th/td cells.
 */
async function extractTablesInFrame(frame) {
  const tables = await frame.evaluate(() => {
    const text = (el) => (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('table')].map((table, idx) => {
      let headers = [];
      const theadCells = table.querySelectorAll('thead th, thead td');
      if (theadCells.length) {
        headers = [...theadCells].map(text);
      } else {
        const firstRow = table.querySelector('tr');
        if (firstRow) headers = [...firstRow.querySelectorAll('th, td')].map(text);
      }

      const bodyRows = table.tBodies.length
        ? [...table.tBodies].flatMap((tb) => [...tb.rows])
        : [...table.rows].slice(headers.length ? 1 : 0);

      const rows = bodyRows.map((tr) =>
        [...tr.cells].map(text),
      );

      return {
        index: idx,
        id: table.id || null,
        className: table.className || null,
        headers,
        rowCount: rows.length,
        rows,
      };
    });
  });
  // Tag each with its frame URL so the dashboard can show where it came from.
  return tables.map((t) => ({ ...t, frameUrl: frame.url() }));
}

async function extractAllTables(page) {
  const all = [];
  for (const frame of page.frames()) {
    try {
      const ts = await extractTablesInFrame(frame);
      all.push(...ts);
    } catch {
      // Cross-origin frames or detached frames: ignore.
    }
  }
  return all;
}

/**
 * Read the textContent of each requested HTML id.
 */
async function extractDataFields(page, dataFields) {
  if (!dataFields?.length) return {};
  // Strip Mongoose subdoc wrappers — page.evaluate can't serialize them.
  const plain = dataFields.map((f) => ({ id: f.id, label: f.label }));

  const out = Object.fromEntries(plain.map((f) => [f.label, null]));

  // Search every frame; first hit per id wins. Handles dashboards that render
  // widgets inside an iframe.
  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate((fields) => {
        const cleanText = (s) => {
          let t = (s ?? '').replace(/\s+/g, ' ').trim();
          while (t.startsWith('[') && t.endsWith(']')) {
            t = t.slice(1, -1).trim();
          }
          return t;
        };
        const r = {};
        for (const { id, label } of fields) {
          const el = document.getElementById(id);
          if (el) r[label] = cleanText(el.innerText ?? el.textContent ?? '');
        }
        return r;
      }, plain);
      for (const [k, v] of Object.entries(found)) {
        if (out[k] == null && v != null) out[k] = v;
      }
    } catch {
      // Cross-origin or detached frame — ignore.
    }
  }
  return out;
}

/**
 * Run a single fetch cycle for a profile using an EXISTING context.
 * The caller (typically the context pool) is responsible for the context lifecycle.
 */
export async function runFetch(profile, context, { log } = {}) {
  // Restore cookies persisted during login (no-op if already in this context).
  const restored = await restoreCookies(profile, context);

  try {
    const targetHost = new URL(profile.targetUrl).host;
    const cookies = await context.cookies(profile.targetUrl);
    const allCookies = await context.cookies();
    log?.info?.(
      {
        profile: profile.name,
        targetHost,
        restoredFromFile: restored,
        cookiesForTarget: cookies.length,
        totalCookies: allCookies.length,
      },
      'fetch starting',
    );
  } catch {}

  const page = context.pages()[0] || (await context.newPage());

  await page.goto(profile.targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  if (await looksLikeLoginPage(page, profile.targetUrl)) {
    return {
      loggedIn: false,
      url: page.url(),
      message: 'Profile session is missing or expired. Click Login on this profile to refresh it.',
    };
  }

  if (profile.buttonSelector) {
    const btn = page.locator(profile.buttonSelector).first();
    await btn.waitFor({ state: 'visible', timeout: 15000 });
    await btn.click();
  }

  // Wait for the expected data to actually be in the DOM. Different per kind:
  //  - cgaming: a table row appears after the button click.
  //  - zoomwlb: dashboard widget ids (#TODAYNEWPLAYER etc.) get populated by AJAX.
  if (profile.kind === 'zoomwlb') {
    const expectedIds = Object.values(ZOOMWLB_FIELD_IDS);
    const waits = [];
    for (const frame of page.frames()) {
      for (const id of expectedIds) {
        waits.push(frame.waitForSelector(`#${id}`, { timeout: 20000 }).catch(() => null));
      }
    }
    if (waits.length) await Promise.race(waits);
  } else {
    await Promise.race([
      page.waitForSelector('table tbody tr', { timeout: 20000 }).catch(() => null),
      ...page.frames().map((f) =>
        f.waitForSelector('table tbody tr', { timeout: 20000 }).catch(() => null),
      ),
    ]);
  }
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  // For zoomwlb, extract the fixed set of common-schema IDs (overrides any
  // per-profile dataFields). For other kinds, fall back to user dataFields.
  const fieldDefs = profile.kind === 'zoomwlb'
    ? Object.entries(ZOOMWLB_FIELD_IDS).map(([commonKey, id]) => ({ id, label: commonKey }))
    : (profile.dataFields || []);

  const [tables, fields, title] = await Promise.all([
    extractAllTables(page),
    extractDataFields(page, fieldDefs),
    page.title().catch(() => ''),
  ]);

  return {
    loggedIn: true,
    url: page.url(),
    title,
    frameCount: page.frames().length,
    tables,
    fields,
  };
}

/**
 * Lightweight session-keeper: navigates to the target URL on the supplied
 * context and reports whether we're still logged in. No button click, no
 * extraction, no DB writes. Used by the "Profile refresh" scheduler slot to
 * keep the server-side session alive on sites that idle-out.
 */
export async function runRefresh(profile, context, { log } = {}) {
  await restoreCookies(profile, context);
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(profile.targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  const loggedIn = !(await looksLikeLoginPage(page, profile.targetUrl));
  log?.info?.({ profile: profile.name, loggedIn, url: page.url() }, 'refresh tick');
  return { loggedIn, url: page.url() };
}

/**
 * One-shot fetch: opens its own context, runs, closes it.
 * Prefer the context pool for repeated fetches on the same profile.
 */
export async function fetchProfileData(profile, { headless = true, log } = {}) {
  const context = await openContext(profile, { headless });
  try {
    return await runFetch(profile, context, { log });
  } finally {
    await context.close();
  }
}
