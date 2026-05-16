import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import fastifyCookie from '@fastify/cookie';
import { config } from '../config.js';

export const COOKIE_NAME = 'token';

async function authPlugin(fastify) {
  await fastify.register(fastifyCookie);
  await fastify.register(fastifyJwt, {
    secret: config.jwtSecret,
    cookie: {
      cookieName: COOKIE_NAME,
      signed: false,
    },
  });

  // Verifies JWT cookie. For HTML requests, redirect to /login on failure.
  // For API requests (Accept: application/json), return 401.
  fastify.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify();
    } catch (err) {
      const wantsHtml = (request.headers.accept || '').includes('text/html');
      if (wantsHtml) {
        return reply.redirect('/login');
      }
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
}

export default fp(authPlugin);
