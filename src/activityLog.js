// Audit-log recorder + reader.
//
// recordActivity is FIRE-AND-FORGET: it never throws and never blocks the
// caller, so adding it to a request handler can't break that feature. Call it
// without awaiting.

import { ActivityLog, ACTOR_TYPES } from './models/ActivityLog.js';

export function recordActivity({ actorType = 'system', actor = '', action, target = '', details = '', meta = {} } = {}) {
  if (!action) return;
  try {
    ActivityLog.create({ actorType, actor, action, target, details, meta }).catch(() => {});
  } catch {
    /* never disturb the caller */
  }
}

export async function getActivity({ page = 1, pageSize = 25, actorType } = {}) {
  const query = {};
  if (actorType && ACTOR_TYPES.includes(actorType)) query.actorType = actorType;

  const limit = Math.min(Math.max(Number(pageSize) || 25, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  const skip = (current - 1) * limit;

  const [items, total] = await Promise.all([
    ActivityLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ActivityLog.countDocuments(query),
  ]);

  return { items, total, page: current, pageSize: limit };
}
