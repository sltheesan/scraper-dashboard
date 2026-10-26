import { exportAll, restoreAll } from '../backup.js';
import { recordActivity } from '../activityLog.js';
import { logEvent } from '../logBroker.js';

export default async function backupRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  // Download a full DB backup as a JSON attachment.
  fastify.get('/', async (request, reply) => {
    const text = await exportAll();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const filename = `scraper-backup-${stamp}.json`;
    recordActivity({
      actorType: 'admin',
      actor: request.user?.username || '',
      action: 'backup.download',
      details: `${Math.round(text.length / 1024)} KB`,
    });
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(text);
  });

  // Restore from an uploaded JSON backup. Full replace per collection.
  fastify.post('/restore', {
    // Larger limit than the Fastify default 1 MB; backups can grow with scrapes.
    bodyLimit: 50 * 1024 * 1024,
    handler: async (request, reply) => {
      try {
        const { restored, skipped, snapshot } = await restoreAll(request.body);
        const total = Object.values(restored).reduce((a, b) => a + b, 0);
        const lines = Object.entries(restored).map(([k, v]) => `${k}=${v}`).join(', ');
        const skippedNote = skipped.length ? ` · preserved (not in backup): ${skipped.join(', ')}` : '';
        logEvent({ level: 'warn', source: 'backup', message: `Restore complete — ${total} docs (${lines})${skippedNote}` });
        recordActivity({
          actorType: 'admin',
          actor: request.user?.username || '',
          action: 'backup.restore',
          details: `${lines}${skippedNote}`,
        });
        return { ok: true, restored, skipped, snapshot };
      } catch (err) {
        request.log.error({ err }, 'restore failed');
        return reply.code(400).send({ error: 'restore_failed', message: err.message });
      }
    },
  });
}
