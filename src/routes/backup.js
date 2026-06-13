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
        const summary = await restoreAll(request.body);
        const total = Object.values(summary).reduce((a, b) => a + b, 0);
        const lines = Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(', ');
        logEvent({ level: 'warn', source: 'backup', message: `Restore complete — ${total} docs (${lines})` });
        recordActivity({
          actorType: 'admin',
          actor: request.user?.username || '',
          action: 'backup.restore',
          details: lines,
        });
        return { ok: true, summary };
      } catch (err) {
        request.log.error({ err }, 'restore failed');
        return reply.code(400).send({ error: 'restore_failed', message: err.message });
      }
    },
  });
}
