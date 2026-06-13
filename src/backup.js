// Database backup + restore.
//
// Backup: serializes every app collection to a single JSON file using BSON's
// Extended JSON, so ObjectIds and Dates round-trip faithfully.
// Restore: full-replace per collection (clears, then inserts).
//
// Note: this does NOT include the on-disk browser profile folders
// (profiles/<name>/), so after restoring on a different machine those profiles
// will show logged_out until you re-login.

import { EJSON } from 'bson';
import { Profile } from './models/Profile.js';
import { Scrape } from './models/Scrape.js';
import {
  ScheduleSetting,
  getSettings as getSchedulerSettings,
} from './models/ScheduleSetting.js';
import { TelegramSetting } from './models/TelegramSetting.js';
import { ActivityLog } from './models/ActivityLog.js';
import { applySettings, rescheduleAll } from './scheduler.js';

export const BACKUP_VERSION = 1;

// Order matters for restore — settings come first so the scheduler is sane if
// anything fails partway through.
const COLLECTIONS = [
  ['schedulesettings', ScheduleSetting],
  ['telegramsettings', TelegramSetting],
  ['profiles', Profile],
  ['scrapes', Scrape],
  ['activitylogs', ActivityLog],
];

/** Build the backup payload as an EJSON string. */
export async function exportAll() {
  const collections = {};
  for (const [name, Model] of COLLECTIONS) {
    collections[name] = await Model.find({}).lean();
  }
  const payload = {
    version: BACKUP_VERSION,
    exportedAt: new Date(),
    collections,
  };
  return EJSON.stringify(payload, { relaxed: false });
}

/**
 * Restore from a parsed JSON body (Fastify-parsed object).
 * Validates the header, clears each known collection, and inserts the docs
 * from the backup. Refreshes the in-memory scheduler state at the end.
 * Returns { collection: count } summary.
 */
export async function restoreAll(parsedBody) {
  // Revive {$oid}/{$date}/etc. markers into real BSON types.
  const data = EJSON.deserialize(parsedBody);
  if (!data || typeof data !== 'object' || !data.collections) {
    throw new Error('Invalid backup file (no `collections`).');
  }
  if (data.version !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version: ${data.version}`);
  }

  const summary = {};
  for (const [name, Model] of COLLECTIONS) {
    const docs = Array.isArray(data.collections[name]) ? data.collections[name] : [];
    await Model.deleteMany({});
    if (docs.length) {
      // Raw driver insertMany bypasses Mongoose validation/defaults so the
      // backup is restored byte-for-byte (preserves _id, timestamps, etc.).
      await Model.collection.insertMany(docs, { ordered: false });
    }
    summary[name] = docs.length;
  }

  // Re-arm the scheduler's in-memory cache against the restored settings/
  // profiles. Best effort — never throw from here.
  try {
    const next = await getSchedulerSettings();
    applySettings(next);
    await rescheduleAll();
  } catch { /* ignore */ }

  return summary;
}
