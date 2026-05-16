// Per-profile browser context pool.
// Keeps one BrowserContext alive per profile so repeated fetches reuse the
// same browser process instead of spawning Chromium every time.

import { openContext } from './scraper.js';

const pool = new Map();      // profileId(str) -> BrowserContext
const pending = new Map();   // profileId(str) -> Promise<BrowserContext>
const idleTimers = new Map();// profileId(str) -> Timeout

const IDLE_MS = 30 * 60 * 1000; // close contexts unused for 30 minutes

function clearIdle(id) {
  const t = idleTimers.get(id);
  if (t) {
    clearTimeout(t);
    idleTimers.delete(id);
  }
}

function scheduleIdle(id) {
  clearIdle(id);
  idleTimers.set(id, setTimeout(() => evict(id), IDLE_MS));
}

async function evict(id) {
  const ctx = pool.get(id);
  pool.delete(id);
  clearIdle(id);
  if (!ctx) return;
  try { await ctx.close(); } catch {}
}

/**
 * Get a context for this profile, opening one if needed.
 * Safe to call concurrently — overlapping calls share one launch.
 */
export async function acquireContext(profile, opts) {
  const id = String(profile._id);
  const existing = pool.get(id);
  if (existing) {
    scheduleIdle(id);
    return existing;
  }
  if (pending.has(id)) {
    return pending.get(id);
  }

  const promise = openContext(profile, opts)
    .then((ctx) => {
      pool.set(id, ctx);
      pending.delete(id);
      ctx.on('close', () => {
        if (pool.get(id) === ctx) {
          pool.delete(id);
          clearIdle(id);
        }
      });
      scheduleIdle(id);
      return ctx;
    })
    .catch((err) => {
      pending.delete(id);
      throw err;
    });

  pending.set(id, promise);
  return promise;
}

/**
 * Close the pooled context for a profile (e.g. before manual login, or on delete).
 */
export async function releaseContext(profileId) {
  await evict(String(profileId));
}

/**
 * Close every pooled context. Call on server shutdown.
 */
export async function closeAll() {
  const ids = [...pool.keys()];
  await Promise.all(ids.map((id) => evict(id)));
}

/**
 * For diagnostics / future status endpoints.
 */
export function poolSize() {
  return pool.size;
}
