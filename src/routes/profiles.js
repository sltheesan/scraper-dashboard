import path from 'node:path';
import { config } from '../config.js';
import { Profile, PROFILE_STATUSES, PROFILE_KINDS } from '../models/Profile.js';
import { openContext, persistCookies } from '../scraper.js';
import { acquireContext, releaseContext } from '../contextPool.js';
import { runAndParse } from '../scrapeRunner.js';
import { reschedule } from '../scheduler.js';
import { logEvent } from '../logBroker.js';

// In-memory map of profileId -> { context, page, openedAt }.
// Lost on server restart; that's fine for dev (any orphaned browsers can be
// closed manually).
const loginSessions = new Map();

const PROFILES_DIR = path.resolve('profiles');

const profileBody = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-zA-Z0-9_-]+$' },
    kind: { type: 'string', enum: PROFILE_KINDS },
    loginUrl: { type: 'string', minLength: 1 },
    targetUrl: { type: 'string', minLength: 1 },
    refreshIntervalMs: { type: 'integer', minimum: 10000 },
    buttonSelector: { type: 'string' },
    dataFields: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'label'],
        properties: {
          id: { type: 'string', minLength: 1 },
          label: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
    },
    proxy: { type: 'string' },
    notes: { type: 'string' },
    status: { type: 'string', enum: PROFILE_STATUSES },
  },
  additionalProperties: false,
};

function toClient(doc) {
  const o = doc.toObject({ versionKey: false });
  o.id = String(o._id);
  delete o._id;
  return o;
}

export default async function profileRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/', async () => {
    const profiles = await Profile.find().sort({ createdAt: -1 });
    return profiles.map(toClient);
  });

  fastify.get('/:id', async (request, reply) => {
    const profile = await Profile.findById(request.params.id);
    if (!profile) return reply.code(404).send({ error: 'not found' });
    return toClient(profile);
  });

  fastify.post('/', {
    schema: {
      body: { ...profileBody, required: ['name', 'loginUrl', 'targetUrl'] },
    },
    handler: async (request, reply) => {
      const data = { ...request.body };
      data.userDataDir = path.join(PROFILES_DIR, data.name);

      try {
        const profile = await Profile.create(data);
        reschedule(profile._id).catch(() => {});
        return reply.code(201).send(toClient(profile));
      } catch (err) {
        if (err.code === 11000) {
          return reply.code(409).send({ error: 'name already exists' });
        }
        throw err;
      }
    },
  });

  fastify.patch('/:id', {
    schema: { body: profileBody },
    handler: async (request, reply) => {
      const updates = { ...request.body };
      // userDataDir is derived from name; keep them in sync
      if (updates.name) {
        updates.userDataDir = path.join(PROFILES_DIR, updates.name);
      }

      try {
        const profile = await Profile.findByIdAndUpdate(
          request.params.id,
          updates,
          { new: true, runValidators: true },
        );
        if (!profile) return reply.code(404).send({ error: 'not found' });
        reschedule(profile._id).catch(() => {});
        return toClient(profile);
      } catch (err) {
        if (err.code === 11000) {
          return reply.code(409).send({ error: 'name already exists' });
        }
        throw err;
      }
    },
  });

  fastify.delete('/:id', async (request, reply) => {
    const profile = await Profile.findByIdAndDelete(request.params.id);
    if (!profile) return reply.code(404).send({ error: 'not found' });
    await releaseContext(request.params.id);
    reschedule(request.params.id).catch(() => {});
    return { ok: true };
  });

  // Start a manual login session: open headed Chromium at the loginUrl on the
  // server and keep the context alive in memory until /login/finish (or until
  // the user closes the window).
  fastify.post('/:id/login', async (request, reply) => {
    const profile = await Profile.findById(request.params.id);
    if (!profile) return reply.code(404).send({ error: 'not found' });

    const existing = loginSessions.get(String(profile._id));
    if (existing) {
      // Bring it to front by reloading the login URL.
      try { await existing.page.bringToFront(); } catch {}
      return { ok: true, alreadyOpen: true };
    }

    // Free any pooled fetch context for this profile so the login flow can
    // open the same userDataDir (Chromium refuses two browsers on one dir).
    await releaseContext(profile._id);

    const context = await openContext(profile, { headless: false });
    const page = context.pages()[0] || (await context.newPage());

    try {
      await page.goto(profile.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      request.log.warn({ err }, 'login page navigation failed');
    }

    const id = String(profile._id);
    loginSessions.set(id, { context, page, openedAt: new Date() });
    logEvent({ source: 'login', profile: profile.name, message: 'Login window opened' });

    // Auto-cleanup if the user closes the browser window manually.
    context.on('close', async () => {
      loginSessions.delete(id);
      try {
        const p = await Profile.findById(id);
        if (p) {
          p.status = 'logged_in';
          p.lastLoginAt = new Date();
          await p.save();
        }
      } catch {}
    });

    return { ok: true, alreadyOpen: false };
  });

  // Save the login session: close the headed browser and mark profile logged_in.
  fastify.post('/:id/login/finish', async (request, reply) => {
    const id = String(request.params.id);
    const session = loginSessions.get(id);
    if (!session) {
      return reply.code(404).send({ error: 'no active login session' });
    }

    // Snapshot what we have right before closing so we can verify the login
    // actually reached the post-auth state, then persist cookies (extending
    // session-only ones so they survive the next browser launch).
    const profile = await Profile.findById(id);
    let savedCookieCount = 0;
    try {
      const currentUrl = session.page.url();
      const allCookies = await session.context.cookies();
      if (profile) {
        savedCookieCount = await persistCookies(profile, session.context);
      }
      request.log.info(
        {
          profile: profile?.name,
          currentUrl,
          totalCookies: allCookies.length,
          savedCookieCount,
          cookieNames: allCookies.map((c) => c.name),
        },
        'login save: snapshot before close',
      );
    } catch (err) {
      request.log.warn({ err }, 'login save: snapshot/persist failed');
    }

    loginSessions.delete(id);
    try { await session.context.close(); } catch {}

    if (profile) {
      profile.status = 'logged_in';
      profile.lastLoginAt = new Date();
      await profile.save();
      logEvent({ source: 'login', profile: profile.name, message: 'Login session saved' });
    }
    return { ok: true };
  });

  // Cancel a login session without marking it logged_in.
  fastify.post('/:id/login/cancel', async (request, reply) => {
    const id = String(request.params.id);
    const session = loginSessions.get(id);
    if (!session) return { ok: true };
    loginSessions.delete(id);
    try { await session.context.close(); } catch {}
    return { ok: true };
  });

  // Manual fetch — opens browser via context pool, navigates, extracts,
  // returns a preview. Does NOT persist anything; storage is the scheduler's job.
  fastify.post('/:id/fetch', async (request, reply) => {
    const profile = await Profile.findById(request.params.id);
    if (!profile) return reply.code(404).send({ error: 'not found' });

    logEvent({ source: 'manual', profile: profile.name, message: 'Manual fetch started' });

    try {
      const { result, parsed } = await runAndParse(profile, {
        headless: config.headless,
        log: request.log,
      });

      if (!result.loggedIn) {
        profile.status = 'logged_out';
        await profile.save();
        logEvent({
          level: 'warn',
          source: 'manual',
          profile: profile.name,
          message: 'Manual fetch: session expired',
        });
        return reply.code(409).send({
          error: 'logged_out',
          message: result.message,
          url: result.url,
        });
      }

      profile.status = 'logged_in';
      await profile.save();
      logEvent({
        source: 'manual',
        profile: profile.name,
        message: parsed ? 'Manual fetch: preview ready (not saved)' : 'Manual fetch: no values',
      });

      return {
        ok: true,
        kind: profile.kind,
        url: result.url,
        title: result.title,
        frameCount: result.frameCount,
        tables: result.tables,
        fields: result.fields,
        parsed: parsed ? { ...parsed, kind: profile.kind } : null,
      };
    } catch (err) {
      request.log.error({ err }, 'fetch failed');
      profile.status = 'error';
      await profile.save();
      logEvent({
        level: 'error',
        source: 'manual',
        profile: profile.name,
        message: `Manual fetch failed: ${err.message}`,
      });
      return reply.code(500).send({ error: 'fetch_failed', message: err.message });
    }
  });
}
