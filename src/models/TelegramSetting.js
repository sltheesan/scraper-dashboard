import mongoose from 'mongoose';

// Singleton: exactly one document keyed by SINGLETON_KEY holds the bot's
// access policy. The bot token itself lives in .env (TELEGRAM_BOT_TOKEN);
// only the allowlist is managed here so it can be edited from the dashboard.
const SINGLETON_KEY = 'global';

const telegramSettingSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: SINGLETON_KEY },
    // When true, only chat IDs in allowedChatIds may use the bot.
    // When false, anyone who messages the bot is served.
    restricted: { type: Boolean, default: true },
    // Telegram chat IDs (stored as strings — they can exceed 2^53).
    allowedChatIds: { type: [String], default: [] },
    // Telegram @usernames, stored normalized (no '@', lowercase).
    allowedUsernames: { type: [String], default: [] },
    // Reply format: send the rendered image card, the text summary, or both.
    sendImage: { type: Boolean, default: true },
    sendText: { type: Boolean, default: true },
    // Chat ids that receive "session expired" alerts. Empty list = disabled.
    alertChatIds: { type: [String], default: [] },
    // Deprecated single-value field; auto-migrated into alertChatIds on read.
    alertChatId: { type: String, default: '' },
  },
  { timestamps: true },
);

export const TelegramSetting = mongoose.model('TelegramSetting', telegramSettingSchema);

// Normalize a username for storage/compare: drop a leading '@', lowercase.
export function normalizeUsername(name) {
  return String(name || '').trim().replace(/^@/, '').toLowerCase();
}

function toPlain(doc) {
  return {
    restricted: !!doc.restricted,
    allowedChatIds: [...(doc.allowedChatIds || [])],
    allowedUsernames: [...(doc.allowedUsernames || [])],
    sendImage: doc.sendImage !== false,
    sendText: doc.sendText !== false,
    alertChatIds: [...(doc.alertChatIds || [])],
  };
}

export async function getTelegramSettings() {
  let doc = await TelegramSetting.findOne({ key: SINGLETON_KEY });
  if (!doc) doc = await TelegramSetting.create({ key: SINGLETON_KEY });
  // One-time migration from the old single alertChatId → alertChatIds array.
  if ((!doc.alertChatIds || !doc.alertChatIds.length) && doc.alertChatId) {
    doc.alertChatIds = [doc.alertChatId];
    doc.alertChatId = '';
    await doc.save().catch(() => {});
  }
  return toPlain(doc);
}

// Update any of the boolean flags (restricted, sendImage, sendText).
// Only keys present in `updates` are written.
export async function updateTelegramSettings(updates) {
  const $set = {};
  for (const key of ['restricted', 'sendImage', 'sendText']) {
    if (typeof updates[key] === 'boolean') $set[key] = updates[key];
  }
  const doc = await TelegramSetting.findOneAndUpdate(
    { key: SINGLETON_KEY },
    { $set, $setOnInsert: { key: SINGLETON_KEY } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return toPlain(doc);
}

export async function addChatId(chatId) {
  const id = String(chatId).trim();
  const doc = await TelegramSetting.findOneAndUpdate(
    { key: SINGLETON_KEY },
    { $addToSet: { allowedChatIds: id }, $setOnInsert: { key: SINGLETON_KEY } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return toPlain(doc);
}

export async function removeChatId(chatId) {
  const id = String(chatId).trim();
  const doc = await TelegramSetting.findOneAndUpdate(
    { key: SINGLETON_KEY },
    { $pull: { allowedChatIds: id } },
    { new: true },
  );
  return doc ? toPlain(doc) : { restricted: true, allowedChatIds: [], allowedUsernames: [] };
}

export async function addAlertChatId(chatId) {
  const id = String(chatId).trim();
  const doc = await TelegramSetting.findOneAndUpdate(
    { key: SINGLETON_KEY },
    { $addToSet: { alertChatIds: id }, $setOnInsert: { key: SINGLETON_KEY } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return toPlain(doc);
}

export async function removeAlertChatId(chatId) {
  const id = String(chatId).trim();
  const doc = await TelegramSetting.findOneAndUpdate(
    { key: SINGLETON_KEY },
    { $pull: { alertChatIds: id } },
    { new: true },
  );
  return doc ? toPlain(doc) : { restricted: true, allowedChatIds: [], allowedUsernames: [], alertChatIds: [] };
}

export async function addUsername(username) {
  const u = normalizeUsername(username);
  const doc = await TelegramSetting.findOneAndUpdate(
    { key: SINGLETON_KEY },
    { $addToSet: { allowedUsernames: u }, $setOnInsert: { key: SINGLETON_KEY } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return toPlain(doc);
}

export async function removeUsername(username) {
  const u = normalizeUsername(username);
  const doc = await TelegramSetting.findOneAndUpdate(
    { key: SINGLETON_KEY },
    { $pull: { allowedUsernames: u } },
    { new: true },
  );
  return doc ? toPlain(doc) : { restricted: true, allowedChatIds: [], allowedUsernames: [] };
}

// Used by the bot on every update — cheap single-doc read.
// Allowed if access is open, or the chat ID OR the @username is on the list.
export async function isAllowed({ chatId, username } = {}) {
  const { restricted, allowedChatIds, allowedUsernames } = await getTelegramSettings();
  if (!restricted) return true;
  if (chatId != null && allowedChatIds.includes(String(chatId))) return true;
  if (username && allowedUsernames.includes(normalizeUsername(username))) return true;
  return false;
}
