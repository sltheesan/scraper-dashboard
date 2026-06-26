// Standalone full-database backup (zero external tools).
//
// Reuses the app's exportAll() to write a faithful EJSON snapshot (ObjectIds and
// Dates preserved) of every collection to backups/. Read-only on the DB.
// Works the same on this PC and the Linux VPS.
//
//   npm run backup            -> backups/scraper-backup-<timestamp>.json
//   npm run backup -- /path   -> write into a custom directory
//
// Lives in tools/ (NOT watched by nodemon) so running it never restarts a dev
// server.

import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { exportAll } from '../src/backup.js';

const outDir = path.resolve(process.argv[2] || 'backups');

async function main() {
  await mongoose.connect(config.mongoUrl);
  const dbName = mongoose.connection.name;
  console.log(`Connected to ${config.mongoUrl} (db: ${dbName})`);

  const text = await exportAll();
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(outDir, `scraper-backup-${stamp}.json`);
  await fs.writeFile(file, text, 'utf8');

  const kb = Math.round(text.length / 1024);
  console.log(`Backup written: ${file} (${kb} KB)`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Backup failed:', err);
  process.exit(1);
});
