import mongoose from 'mongoose';
import { isValidCutover, DEFAULT_CUTOVER } from '../businessDay.js';

// Singleton: there's exactly one document keyed by SINGLETON_KEY.
const SINGLETON_KEY = 'global';

const slotSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    intervalMs: { type: Number, default: 300000, min: 30000 }, // 5 min default
  },
  { _id: false },
);

// Per-platform business-day config (one entry each for cgaming / zoomwlb).
const platformSchema = new mongoose.Schema(
  {
    // "HH:MM" ICT — time a new day starts; the prior day ends 1s before this.
    dayCutover: { type: String, default: DEFAULT_CUTOVER },
    // What a live "today" fetch does when the source hasn't published today's
    // period yet: 'calm' = a clear "not started" result; 'fallback' = show the
    // most recent complete day instead.
    todayMissing: { type: String, enum: ['calm', 'fallback'], default: 'calm' },
  },
  { _id: false },
);

const scheduleSettingSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: SINGLETON_KEY },
    // "Scheduled refresh & fetch" — extracts + saves to DB.
    fetch: { type: slotSchema, default: () => ({}) },
    // "Profile refresh to avoid session timeout" — navigate-only, no save.
    refresh: { type: slotSchema, default: () => ({}) },
    // Business-day cutover + missing-today behavior, per platform kind.
    platforms: {
      cgaming: { type: platformSchema, default: () => ({}) },
      zoomwlb: { type: platformSchema, default: () => ({}) },
    },
  },
  { timestamps: true },
);

export const ScheduleSetting = mongoose.model('ScheduleSetting', scheduleSettingSchema);

function plainSlot(slot) {
  return {
    enabled: !!slot?.enabled,
    intervalMs: Number(slot?.intervalMs) || 300000,
  };
}

function plainPlatform(p) {
  return {
    dayCutover: isValidCutover(p?.dayCutover) ? p.dayCutover : DEFAULT_CUTOVER,
    todayMissing: p?.todayMissing === 'fallback' ? 'fallback' : 'calm',
  };
}

function plainPlatforms(pp) {
  return {
    cgaming: plainPlatform(pp?.cgaming),
    zoomwlb: plainPlatform(pp?.zoomwlb),
  };
}

function plainSettings(doc) {
  return {
    fetch: plainSlot(doc.fetch),
    refresh: plainSlot(doc.refresh),
    platforms: plainPlatforms(doc.platforms),
  };
}

export async function getSettings() {
  let doc = await ScheduleSetting.findOne({ key: SINGLETON_KEY });
  if (!doc) doc = await ScheduleSetting.create({ key: SINGLETON_KEY });
  return plainSettings(doc);
}

/** Convenience: resolved { dayCutover, todayMissing } for one platform kind. */
export async function getPlatformConfig(kind) {
  const s = await getSettings();
  return s.platforms[kind] || plainPlatform(null);
}

export async function updateSettings(updates) {
  const $set = {};
  if (updates.fetch) {
    if (typeof updates.fetch.enabled === 'boolean') $set['fetch.enabled'] = updates.fetch.enabled;
    if (Number.isFinite(updates.fetch.intervalMs)) $set['fetch.intervalMs'] = updates.fetch.intervalMs;
  }
  if (updates.refresh) {
    if (typeof updates.refresh.enabled === 'boolean') $set['refresh.enabled'] = updates.refresh.enabled;
    if (Number.isFinite(updates.refresh.intervalMs)) $set['refresh.intervalMs'] = updates.refresh.intervalMs;
  }
  for (const kind of ['cgaming', 'zoomwlb']) {
    const p = updates.platforms?.[kind];
    if (!p) continue;
    if (isValidCutover(p.dayCutover)) $set[`platforms.${kind}.dayCutover`] = p.dayCutover;
    if (p.todayMissing === 'calm' || p.todayMissing === 'fallback') {
      $set[`platforms.${kind}.todayMissing`] = p.todayMissing;
    }
  }
  const doc = await ScheduleSetting.findOneAndUpdate(
    { key: SINGLETON_KEY },
    { $set, $setOnInsert: { key: SINGLETON_KEY } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return plainSettings(doc);
}
