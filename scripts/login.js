#!/usr/bin/env node
/**
 * Manual login helper.
 *
 * Usage:
 *   npm run login -- <profile-name>
 *
 * Opens a headed Chromium window in the profile's persistent context,
 * navigates to the profile's loginUrl, and waits for you to finish
 * logging in. Press Enter in this terminal when done — the session
 * is saved to profiles/<name>/.
 */

import readline from 'node:readline';
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { connectDb } from '../src/db.js';
import { Profile } from '../src/models/Profile.js';
import { openContext } from '../src/scraper.js';

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: npm run login -- <profile-name>');
    process.exit(1);
  }

  await connectDb();
  const profile = await Profile.findOne({ name });
  if (!profile) {
    console.error(`Profile "${name}" not found.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`\nOpening browser for profile "${profile.name}"...`);
  console.log(`Login URL: ${profile.loginUrl}`);

  const context = await openContext(profile, { headless: false });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(profile.loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('\n→ Log in manually in the browser window.');
  console.log('→ When you have reached the post-login page, come back here and press Enter.\n');

  await prompt('Press Enter when done logging in... ');

  // Best-effort: mark profile as logged_in
  profile.status = 'logged_in';
  profile.lastLoginAt = new Date();
  await profile.save();

  await context.close();
  await mongoose.disconnect();

  console.log(`\nSession saved to: ${profile.userDataDir || `profiles/${profile.name}`}`);
  console.log('You can now click "Fetch" in the dashboard.\n');
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
