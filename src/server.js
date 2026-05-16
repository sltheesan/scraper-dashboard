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
import { Profile } from './models/Profile.js';
import { Scrape } from './models/Scrape.js';
import { ScheduleSetting } from './models/ScheduleSetting.js';
import { closeAll as closeAllContexts } from './contextPool.js';
import { startScheduler, stopScheduler } from './scheduler.js';

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
    ]);
    const fastify = await build();
    fastify.log.info('MongoDB connected');

    await startScheduler(fastify.log);

    // Graceful shutdown: close pooled browsers before exiting.
    let shuttingDown = false;
    const shutdown = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      fastify.log.info(`${signal} received, shutting down…`);
      stopScheduler();
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
