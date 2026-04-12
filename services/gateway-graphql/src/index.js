'use strict';

// OTel must be the very first import — instruments HTTP + Express automatically
require('@carepack/otel-node');
const { correlationFormat } = require('@carepack/otel-node/correlation');

const express          = require('express');
const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');
const { createLogger, format, transports } = require('winston');
const { Pool }         = require('pg');

const { authMiddleware } = require('./middleware/auth');
const { buildContext }   = require('./context');

// ── Logger ────────────────────────────────────────────────────────────────────
const logger = createLogger({
  format: format.combine(correlationFormat(), format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

// ── Postgres pool (reads from patient_dashboard_projection) ───────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

// ── GraphQL schema ────────────────────────────────────────────────────────────
const typeDefs = `#graphql
  type PatientSummary {
    id:         String!
    tenantId:   String!
    mrn:        String!
    fullName:   String!
    ward:       String
    status:     String!
    news2Score: Int
    updatedAt:  String!
  }

  type Query {
    health: String
    patient(id: String!): PatientSummary
    patients: [PatientSummary!]!
  }
`;

const resolvers = {
  Query: {
    health: () => 'ok',

    patient: async (_parent, { id }, ctx) => {
      // Explicit tenant_id filter as defence-in-depth alongside RLS
      const rows = await ctx.tenantQuery(
        `SELECT id, tenant_id, mrn, full_name, ward, status, news2_score, updated_at
         FROM patient_dashboard_projection
         WHERE id = $1
           AND tenant_id = $2`,
        [id, ctx.user.tenantId],
      );
      if (!rows.length) return null;
      return mapRow(rows[0]);
    },

    patients: async (_parent, _args, ctx) => {
      // Explicit tenant_id filter as defence-in-depth alongside RLS
      const rows = await ctx.tenantQuery(
        `SELECT id, tenant_id, mrn, full_name, ward, status, news2_score, updated_at
         FROM patient_dashboard_projection
         WHERE tenant_id = $1
         ORDER BY updated_at DESC`,
        [ctx.user.tenantId],
      );
      return rows.map(mapRow);
    },
  },
};

/** Maps snake_case DB row → camelCase GraphQL object */
function mapRow(row) {
  return {
    id:         row.id,
    tenantId:   row.tenant_id,
    mrn:        row.mrn,
    fullName:   row.full_name,
    ward:       row.ward,
    status:     row.status,
    news2Score: row.news2_score,
    updatedAt:  row.updated_at?.toISOString(),
  };
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main() {
  const app = express();
  app.use(express.json());

  // Health check — no auth needed
  app.get('/healthz', (_req, res) => res.sendStatus(200));

  const apollo = new ApolloServer({ typeDefs, resolvers });
  await apollo.start();

  // All GraphQL requests require a valid JWT
  app.use(
    '/graphql',
    authMiddleware,
    expressMiddleware(apollo, {
      context: ({ req }) => buildContext({ req, pool }),
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
