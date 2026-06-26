// Database backup + restore.
//
// Backup: serializes every app collection to a single JSON file using BSON's
// Extended JSON, so ObjectIds and Dates round-trip faithfully.
// Restore: full-replace per collection (clears, then inserts).
//
// Note: this does NOT include the on-disk browser profile folders
// (profiles/<name>/), so after restoring on a different machine those profiles
// will show logged_out until you re-login.

import fs from 'node:fs/promises';
import path from 'node:path';
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

// Where pre-restore safety snapshots are written. Git-ignored.
const SAFETY_DIR = path.resolve('backups');

/**
 * Take a full export of the CURRENT database and write it to backups/ before a
 * restore touches anything. If this fails we abort the restore — never delete
 * data we couldn't first back up.
 * Returns the absolute path of the snapshot file.
 */
async function writePreRestoreSnapshot(log) {
  try {
    const text = await exportAll();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await fs.mkdir(SAFETY_DIR, { recursive: true });
    const file = path.join(SAFETY_DIR, `pre-restore-${stamp}.json`);
    await fs.writeFile(file, text, 'utf8');
    log?.warn?.({ file }, 'pre-restore safety snapshot written');
    return file;
  } catch (err) {
    throw new Error(`Aborting restore — could not write safety snapshot first: ${err.message}`);
  }
}

/**
 * Restore from a parsed JSON body (Fastify-parsed object).
 *
 * Safety model (this code previously wiped a live DB from an empty body):
 *  1. Reject a backup that has zero documents across ALL collections.
 *  2. Per collection, only REPLACE when the backup actually has docs for it;
 *     an empty/missing array means "no data provided" → leave it untouched.
 *  3. Always write a full snapshot of the current DB to backups/ first; if that
 *     can't be written, abort before deleting anything.
 *
 * Returns { summary: { <collection>: { action, count } }, snapshotPath }.
 */
export async function restoreAll(parsedBody, { log } = {}) {
  // Revive {$oid}/{$date}/etc. markers into real BSON types.
  const data = EJSON.deserialize(parsedBody);
  if (!data || typeof data !== 'object' || !data.collections) {
    throw new Error('Invalid backup file (no `collections`).');
  }
  if (data.version !== BACKUP_VERSION) {
    throw new Error(`Unsupported backup version: ${data.version}`);
  }

  // Guard 1: refuse a backup that would insert nothing anywhere. This is exactly
  // the `{"collections":{}}` shape that caused the original wipe.
  const incoming = {};
  let totalIncoming = 0;
  for (const [name] of COLLECTIONS) {
    const arr = data.collections[name];
    incoming[name] = Array.isArray(arr) ? arr : [];
    totalIncoming += incoming[name].length;
  }
  if (totalIncoming === 0) {
    throw new Error('Refusing restore: backup contains no documents in any collection.');
  }

  // Guard 3: snapshot the live DB before any destructive write.
  const snapshotPath = await writePreRestoreSnapshot(log);

  const summary = {};
  for (const [name, Model] of COLLECTIONS) {
    const docs = incoming[name];
    // Guard 2: never wipe a collection the backup has no data for.
    if (docs.length === 0) {
      summary[name] = { action: 'skipped', count: 0 };
      continue;
    }
    await Model.deleteMany({});
    // Raw driver insertMany bypasses Mongoose validation/defaults so the
    // backup is restored byte-for-byte (preserves _id, timestamps, etc.).
    await Model.collection.insertMany(docs, { ordered: false });
    summary[name] = { action: 'replaced', count: docs.length };
  }

  // Re-arm the scheduler's in-memory cache against the restored settings/
  // profiles. Best effort — never throw from here.
  try {
    const next = await getSchedulerSettings();
    applySettings(next);
    await rescheduleAll();
  } catch { /* ignore */ }

  return { summary, snapshotPath };
}
