import { getRecent, subscribe } from '../logBroker.js';

export default async function logRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/stream', (request, reply) => {
    // Take over the raw socket — we'll keep this connection open and write
    // SSE chunks as events arrive.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Socket gone; cleanup happens via the 'close' handler below.
      }
    };

    // Initial dump of recent events for context.
    for (const e of getRecent()) send(e);

    // Subscribe for new events.
    const unsubscribe = subscribe(send);

    // Keep idle proxies/load-balancers from closing us.
    const heartbeat = setInterval(() => {
      try { res.write(': hb\n\n'); } catch {}
    }, 25000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
