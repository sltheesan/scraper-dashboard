import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { connectDb } from './db.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profiles.js';
import settingsRoutes from './routes/settings.js';
import logRoutes from './routes/logs.js';
import activityRoutes from './routes/activity.js';
import backupRoutes from './routes/backup.js';
import { Profile } from './models/Profile.js';
import { Scrape } from './models/Scrape.js';
import { ScheduleSetting } from './models/ScheduleSetting.js';
import { TelegramSetting } from './models/TelegramSetting.js';
import { ActivityLog } from './models/ActivityLog.js';
import { closeAll as closeAllContexts } from './contextPool.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { startTelegramBot, stopTelegramBot } from './telegram.js';
import { startDailyCapture, stopDailyCapture } from './dailyCapture.js';

// Operate in Indochina Time (GMT+7) unless TZ is explicitly set in the
// environment. Aligns server-side timestamps, logs, and the cgaming parser's
// "today" matching with the business timezone. Display code also formats
// explicitly in this zone, so this stays correct regardless of the host clock.
process.env.TZ = process.env.TZ || 'Asia/Bangkok';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

async function build() {
  const fastify = Fastify({
    logger: {
      level: config.isProd ? 'info' : 'debug',
      transport: config.isProd
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
    },
    // Default Fastify limit is 1 MB; bump to 100 MB so backup restore uploads
    // (a JSON of every collection) aren't rejected before the route runs.
    bodyLimit: 100 * 1024 * 1024,
  });

  await fastify.register(authPlugin);

  await fastify.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/static/',
  });

  await fastify.register(authRoutes, { prefix: '/api/auth' });
  await fastify.register(profileRoutes, { prefix: '/api/profiles' });
  await fastify.register(settingsRoutes, { prefix: '/api/settings' });
  await fastify.register(logRoutes, { prefix: '/api/logs' });
  await fastify.register(activityRoutes, { prefix: '/api/activity' });
  await fastify.register(backupRoutes, { prefix: '/api/backup' });

  // Public login page
  fastify.get('/login', async (request, reply) => {
    return reply.type('text/html').sendFile('login.html');
  });

  // Protected dashboard (root)
  fastify.get(
    '/',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      return reply.type('text/html').sendFile('index.html');
    },
  );

  fastify.get('/healthz', async () => ({ ok: true }));

  return fastify;
}

async function start() {
  try {
    await connectDb();
    // 1. Remove legacy per-kind ScheduleSetting docs (pre-singleton refactor)
    //    *before* syncing indexes — otherwise the new unique index on `key`
    //    fails to build because all legacy docs share `key: null`.
    await ScheduleSetting.collection.deleteMany({ key: { $exists: false } });
    // 2. Drop indexes that no longer match the schema; add new ones.
    await Promise.all([
      Profile.syncIndexes(),
      Scrape.syncIndexes(),
      ScheduleSetting.syncIndexes(),
      TelegramSetting.syncIndexes(),
      ActivityLog.syncIndexes(),
    ]);
    const fastify = await build();
    fastify.log.info('MongoDB connected');

    await startScheduler(fastify.log);
    await startTelegramBot(fastify.log);
    startDailyCapture(fastify.log);

    // Graceful shutdown: close pooled browsers before exiting.
    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      fastify.log.info(`${signal} received, shutting down…`);
      stopScheduler();
      stopTelegramBot();
      stopDailyCapture();
      try { await closeAllContexts(); } catch {}
      try { await fastify.close(); } catch {}
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    await fastify.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();
