// Renders dashboard-style PNG cards from scrape data using Playwright.
// Reuses one headless browser across renders (cheap newPage per card).
// No persistent context / user-data-dir here — this is pure HTML→image, so
// it won't collide with the scraper's per-profile login browsers.

import { chromium } from 'playwright';
import { COMMON_FIELDS, COMMON_LABELS } from './parsers/common.js';

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    const channel = process.env.BROWSER_CHANNEL ?? 'chrome';
    const opts = { headless: true };
    if (channel) opts.channel = channel;
    browserPromise = chromium.launch(opts).catch((err) => {
      browserPromise = null; // allow retry on next render
      throw err;
    });
  }
  return browserPromise;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function fmtNum(v) {
  if (v == null) return '—';
  return typeof v === 'number' ? v.toLocaleString('en-US') : esc(v);
}

// Amount fields get the accent colour; counts stay neutral.
const AMOUNT_FIELDS = new Set(['totalDepositAmount', 'totalWithdrawalAmount']);

function cardHtml(profile, parsed, when) {
  const tiles = COMMON_FIELDS.map((k) => {
    const valueColor = AMOUNT_FIELDS.has(k) ? '#82aaff' : '#e6e8eb';
    return `
      <div class="tile">
        <div class="tile-label">${esc(COMMON_LABELS[k])}</div>
        <div class="tile-value" style="color:${valueColor}">${fmtNum(parsed.data?.[k])}</div>
      </div>`;
  }).join('');

  return `<!doctype html><html><head><meta charset="utf-8" />
  <style>
    * { box-sizing: border-box; margin: 0; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: transparent;
    }
    #card {
      width: 620px;
      background: #181b22;
      border: 1px solid #262a33;
      border-radius: 16px;
      padding: 28px 30px;
      color: #e6e8eb;
    }
    .head { display: flex; align-items: center; justify-content: space-between; }
    .name { font-size: 28px; font-weight: 700; letter-spacing: 0.5px; }
    .badge {
      font-size: 13px; font-weight: 600; color: #82aaff;
      background: rgba(79,140,255,0.15);
      padding: 5px 12px; border-radius: 999px;
    }
    .when { color: #8a929e; font-size: 14px; margin-top: 4px; }
    .divider { height: 1px; background: #262a33; margin: 22px 0; }
    .grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
    }
    .tile {
      background: #0f1115; border: 1px solid #262a33;
      border-radius: 12px; padding: 16px 18px;
    }
    .tile-label {
      font-size: 12px; font-weight: 600; color: #8a929e;
      text-transform: uppercase; letter-spacing: 0.05em;
    }
    .tile-value { font-size: 26px; font-weight: 700; margin-top: 6px; }
    .foot {
      display: flex; align-items: center; gap: 8px;
      margin-top: 22px; color: #8a929e; font-size: 13px;
    }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #6ce19a; }
  </style></head>
  <body>
    <div id="card">
      <div class="head">
        <div class="name">${esc(profile.name)}</div>
        <div class="badge">${esc(profile.kind)}</div>
      </div>
      <div class="when">${esc(when)}</div>
      <div class="divider"></div>
      <div class="grid">${tiles}</div>
      <div class="foot"><span class="dot"></span>Scraper Dashboard · live fetch</div>
    </div>
  </body></html>`;
}

/**
 * Render a profile stat-card to a PNG Buffer. Returns null if rendering fails
 * (caller should fall back to a text message).
 */
export async function renderProfileCard(profile, parsed, when) {
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage({ deviceScaleFactor: 2 });
    await page.setContent(cardHtml(profile, parsed, when), { waitUntil: 'load' });
    const el = await page.$('#card');
    return await el.screenshot({ type: 'png' });
  } catch {
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

export async function closeRenderer() {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch { /* ignore */ }
  browserPromise = null;
}
