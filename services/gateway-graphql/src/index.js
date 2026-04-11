'use strict';
// OTel must be the very first import — instruments HTTP + Express automatically
require('@carepack/otel-node');
const { correlationFormat } = require('@carepack/otel-node/correlation');

const express = require('express');
const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');
const { createLogger, format, transports } = require('winston');
const crypto = require('node:crypto');

// ── Logger (structured JSON) ──────────────────────────────────────────────────
const logger = createLogger({
  format: format.combine(correlationFormat(), format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

// ── GraphQL schema stub ───────────────────────────────────────────────────────
// Full schema wired in S2 with patient queries + S3 with subscriptions
const typeDefs = `#graphql
  type Query {
    health: String
  }
`;

const resolvers = {
  Query: {
    health: () => 'ok',
  },
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main() {
  const app = express();
  app.use(express.json());

  // healthcheck — used by Docker + Kubernetes probes
  app.get('/healthz', (_req, res) => res.sendStatus(200));

  // Apollo Server
  const apollo = new ApolloServer({ typeDefs, resolvers });
  await apollo.start();

  app.use(
    '/graphql',
    expressMiddleware(apollo, {
      context: async ({ req }) => ({
        // S2: JWT validation + tenant extraction goes here
        correlationId: req.headers['x-correlation-id'] ?? crypto.randomUUID(),
      }),
    }),
  );

  const port = process.env.PORT ?? 4000;
  app.listen(port, () => {
    logger.info({ msg: 'gateway-graphql listening', port });
  });
}

main().catch((err) => {
  logger.error({ msg: 'startup failed', err: err.message });
  process.exit(1);
});
