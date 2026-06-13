import { getSettings, updateSettings } from '../models/ScheduleSetting.js';
import {
  getTelegramSettings,
  updateTelegramSettings,
  addChatId,
  removeChatId,
  addUsername,
  removeUsername,
  addAlertChatId,
  removeAlertChatId,
} from '../models/TelegramSetting.js';
import { applySettings, rescheduleAll, getSnapshot } from '../scheduler.js';
import { getBotInfo, sendTestAlert } from '../telegram.js';
import { config } from '../config.js';
import { logEvent } from '../logBroker.js';
import { recordActivity } from '../activityLog.js';

const audit = (request, action, details) =>
  recordActivity({ actorType: 'admin', actor: request.user?.username || '', action, details });

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
      const summary = `${describe('Fetch', next.fetch)} · ${describe('Refresh', next.refresh)}`;
      logEvent({ source: 'settings', message: summary });
      audit(request, 'settings.scheduler', summary);
      return { ok: true, settings: next };
    },
  });

  // ---- Telegram bot access management ----

  fastify.get('/telegram', async () => {
    const settings = await getTelegramSettings();
    const bot = getBotInfo();
    return {
      settings,
      tokenConfigured: !!config.telegramToken,
      bot, // { username, id } when the bot is running, else null
    };
  });

  fastify.patch('/telegram', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          restricted: { type: 'boolean' },
          sendImage: { type: 'boolean' },
          sendText: { type: 'boolean' },
        },
      },
    },
    handler: async (request, reply) => {
      // Guard: the reply must include at least one of image/text. Check the
      // resulting state (current merged with the incoming change).
      const current = await getTelegramSettings();
      const merged = { ...current, ...request.body };
      if (merged.sendImage === false && merged.sendText === false) {
        return reply.code(400).send({
          error: 'invalid_format',
          message: 'Enable the image card, the text summary, or both.',
        });
      }

      const settings = await updateTelegramSettings(request.body);
      if ('restricted' in request.body) {
        const msg = `Access set to ${settings.restricted ? 'restricted (allowlist)' : 'open to anyone'}`;
        logEvent({ source: 'telegram', message: msg });
        audit(request, 'telegram.access', msg);
      }
      if ('sendImage' in request.body || 'sendText' in request.body) {
        const fmt = settings.sendImage && settings.sendText
          ? 'image + text'
          : settings.sendImage ? 'image only' : 'text only';
        logEvent({ source: 'telegram', message: `Reply format: ${fmt}` });
        audit(request, 'telegram.format', fmt);
      }
      return { ok: true, settings };
    },
  });

  fastify.post('/telegram/chat-ids', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { chatId: { type: 'string', minLength: 1, pattern: '^-?[0-9]+$' } },
        required: ['chatId'],
      },
    },
    handler: async (request, reply) => {
      const settings = await addChatId(request.body.chatId);
      logEvent({ source: 'telegram', message: `Allowed chat ID added: ${request.body.chatId}` });
      audit(request, 'telegram.allow_add', `chat ID ${request.body.chatId}`);
      return reply.code(201).send({ ok: true, settings });
    },
  });

  fastify.delete('/telegram/chat-ids/:chatId', async (request) => {
    const settings = await removeChatId(request.params.chatId);
    logEvent({ source: 'telegram', message: `Allowed chat ID removed: ${request.params.chatId}` });
    audit(request, 'telegram.allow_remove', `chat ID ${request.params.chatId}`);
    return { ok: true, settings };
  });

  fastify.post('/telegram/alert-chats', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { chatId: { type: 'string', minLength: 1, pattern: '^-?[0-9]+$' } },
        required: ['chatId'],
      },
    },
    handler: async (request, reply) => {
      const settings = await addAlertChatId(request.body.chatId);
      logEvent({ source: 'telegram', message: `Alert recipient added: ${request.body.chatId}` });
      audit(request, 'telegram.alert_add', `chat ID ${request.body.chatId}`);
      return reply.code(201).send({ ok: true, settings });
    },
  });

  fastify.delete('/telegram/alert-chats/:chatId', async (request) => {
    const settings = await removeAlertChatId(request.params.chatId);
    logEvent({ source: 'telegram', message: `Alert recipient removed: ${request.params.chatId}` });
    audit(request, 'telegram.alert_remove', `chat ID ${request.params.chatId}`);
    return { ok: true, settings };
  });

  fastify.post('/telegram/test-alert', async (request, reply) => {
    const result = await sendTestAlert();
    const note = result.ok
      ? `sent to ${result.sent}/${result.sent + (result.failed || 0)}`
      : `failed: ${result.error || 'no recipients'}`;
    audit(request, 'telegram.test_alert', note);
    if (!result.ok) return reply.code(400).send({ error: 'test_failed', message: result.error });
    return result;
  });

  fastify.post('/telegram/usernames', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        // optional leading @, then 1–32 of [A-Za-z0-9_]
        properties: { username: { type: 'string', pattern: '^@?[A-Za-z0-9_]{1,32}$' } },
        required: ['username'],
      },
    },
    handler: async (request, reply) => {
      const settings = await addUsername(request.body.username);
      const uname = `@${request.body.username.replace(/^@/, '')}`;
      logEvent({ source: 'telegram', message: `Allowed username added: ${uname}` });
      audit(request, 'telegram.allow_add', `username ${uname}`);
      return reply.code(201).send({ ok: true, settings });
    },
  });

  fastify.delete('/telegram/usernames/:username', async (request) => {
    const settings = await removeUsername(request.params.username);
    const uname = `@${request.params.username.replace(/^@/, '')}`;
    logEvent({ source: 'telegram', message: `Allowed username removed: ${uname}` });
    audit(request, 'telegram.allow_remove', `username ${uname}`);
    return { ok: true, settings };
  });
}
