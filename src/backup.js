// Database backup + restore.
//
// Backup: serializes every app collection to a single JSON file using BSON's
// Extended JSON, so ObjectIds and Dates round-trip faithfully.
// Restore: full-replace per collection (clears, then inserts).
//
// Note: this does NOT include the on-disk browser profile folders
// (profiles/<name>/), so after restoring on a different machine those profiles
// will show logged_out until you re-login.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Where automatic pre-restore safety snapshots are written. These are full
// dumps of the CURRENT database taken immediately before a restore replaces
// anything, so every restore is reversible. Not committed (see .gitignore).
const BACKUP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backups');

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

/** Dump the current DB to a timestamped file before a destructive restore. */
async function writeSafetySnapshot() {
  const text = await exportAll();
  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `pre-restore-${stamp}.json`);
  await writeFile(file, text, 'utf8');
  return file;
}

/**
 * Restore from a parsed JSON body (Fastify-parsed object).
 *
 * DATA-SAFETY CONTRACT (this function must never lose data unintentionally):
 *  - A backup that carries no documents at all is REFUSED (this is the shape
 *    that once wiped production: `{version:1,collections:{}}`).
 *  - A collection whose array is empty/missing is LEFT UNTOUCHED — never
 *    `deleteMany`d. Only collections that actually carry documents are replaced.
 *  - Before replacing anything, the CURRENT database is snapshotted to disk;
 *    if that snapshot cannot be written, the restore ABORTS before any delete.
 *
 * Returns { restored: {name: count}, skipped: [name], snapshot: path }.
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

  // Gather + type-guard the incoming docs per known collection.
  const incoming = COLLECTIONS.map(([name, Model]) => {
    const arr = data.collections[name];
    return { name, Model, docs: Array.isArray(arr) ? arr : [] };
  });

  // HARD GUARD: refuse a backup that would insert nothing anywhere. A genuine
  // backup always contains at least the settings singletons + profiles, so an
  // all-empty payload is corruption/misuse — not a request to erase the DB.
  const totalDocs = incoming.reduce((sum, c) => sum + c.docs.length, 0);
  if (totalDocs === 0) {
    throw new Error('Refusing to restore: backup contains no documents in any collection.');
  }

  // Reversibility: snapshot the current DB before touching it. If we cannot
  // write the snapshot, abort BEFORE any delete — data safety over convenience.
  let snapshot;
  try {
    snapshot = await writeSafetySnapshot();
  } catch (err) {
    throw new Error(`Aborting restore: could not write pre-restore safety snapshot (${err.message}).`);
  }

  const restored = {};
  const skipped = [];
  for (const { name, Model, docs } of incoming) {
    if (docs.length === 0) {
      // Empty/missing => preserve whatever is already there. Never wipe.
      skipped.push(name);
      continue;
    }
    await Model.deleteMany({});
    // Raw driver insertMany bypasses Mongoose validation/defaults so the backup
    // is restored byte-for-byte (preserves _id, timestamps, etc.).
    await Model.collection.insertMany(docs, { ordered: false });
    restored[name] = docs.length;
  }

  // Re-arm the scheduler's in-memory cache against the restored settings/
  // profiles. Best effort — never throw from here.
  try {
    const next = await getSchedulerSettings();
    applySettings(next);
    await rescheduleAll();
  } catch { /* ignore */ }

  return { restored, skipped, snapshot };
}
