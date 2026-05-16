import { config } from '../config.js';
import { COOKIE_NAME } from '../plugins/auth.js';

const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days, in seconds

export default async function authRoutes(fastify) {
  fastify.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string' },
          password: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { username, password } = request.body;
      const ok =
        username === config.adminUsername &&
        password === config.adminPassword;

      if (!ok) {
        return reply.code(401).send({ error: 'invalid credentials' });
      }

      const token = await reply.jwtSign(
        { username },
        { expiresIn: '7d' },
      );

      reply.setCookie(COOKIE_NAME, token, {
        path: '/',
        httpOnly: true,
        secure: config.isProd,
        sameSite: 'lax',
        maxAge: COOKIE_MAX_AGE,
      });

      return { ok: true, username };
    },
  });

  fastify.post('/logout', async (request, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  fastify.get(
    '/me',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      return { username: request.user.username };
    },
  );
}
