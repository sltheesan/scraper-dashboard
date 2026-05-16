import { getSettings, updateSettings } from '../models/ScheduleSetting.js';
import { applySettings, rescheduleAll, getSnapshot } from '../scheduler.js';
import { logEvent } from '../logBroker.js';

const slotSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    intervalMs: { type: 'integer', minimum: 30000 },
  },
};

const patchBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fetch: slotSchema,
    refresh: slotSchema,
  },
};

function describe(label, slot) {
  return slot.enabled
    ? `${label} every ${Math.round(slot.intervalMs / 60000)} min`
    : `${label} disabled`;
}

export default async function settingsRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/scheduler', async () => {
    const settings = await getSettings();
    return { settings, runtime: getSnapshot() };
  });

  fastify.patch('/scheduler', {
    schema: { body: patchBody },
    handler: async (request) => {
      const next = await updateSettings(request.body);
      applySettings(next);
      await rescheduleAll();
      logEvent({
        source: 'settings',
        message: `${describe('Fetch', next.fetch)} · ${describe('Refresh', next.refresh)}`,
      });
      return { ok: true, settings: next };
    },
  });
}
