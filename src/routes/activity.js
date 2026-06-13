import { getActivity } from '../activityLog.js';

export default async function activityRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  fastify.get('/', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100 },
          actorType: { type: 'string', enum: ['admin', 'telegram', 'system'] },
        },
      },
    },
    handler: async (request) => {
      const { page, pageSize, actorType } = request.query;
      return getActivity({ page, pageSize, actorType });
    },
  });
}
