import mongoose from 'mongoose';

// Persistent audit trail of user actions — dashboard (admin) and Telegram.
// Separate from the in-memory live log in logBroker.js. Append-only.
export const ACTOR_TYPES = ['admin', 'telegram', 'system'];

const activityLogSchema = new mongoose.Schema(
  {
    actorType: { type: String, enum: ACTOR_TYPES, required: true, index: true },
    // admin username, or a Telegram "@username" / chat id
    actor: { type: String, default: '' },
    // short machine-ish action key, e.g. 'auth.login', 'profile.create', 'fetch'
    action: { type: String, required: true },
    // what it acted on (usually a profile name)
    target: { type: String, default: '' },
    // human-readable extra context
    details: { type: String, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

// Newest-first listing.
activityLogSchema.index({ createdAt: -1 });

export const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);
