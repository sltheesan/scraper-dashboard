import mongoose from 'mongoose';

// Singleton: there's exactly one document keyed by SINGLETON_KEY.
const SINGLETON_KEY = 'global';

const slotSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    intervalMs: { type: Number, default: 300000, min: 30000 }, // 5 min default
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

export async function getSettings() {
  let doc = await ScheduleSetting.findOne({ key: SINGLETON_KEY });
  if (!doc) doc = await ScheduleSetting.create({ key: SINGLETON_KEY });
  return {
    fetch: plainSlot(doc.fetch),
    refresh: plainSlot(doc.refresh),
  };
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
  const doc = await ScheduleSetting.findOneAndUpdate(
    { key: SINGLETON_KEY },
    { $set, $setOnInsert: { key: SINGLETON_KEY } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return {
    fetch: plainSlot(doc.fetch),
    refresh: plainSlot(doc.refresh),
  };
}
