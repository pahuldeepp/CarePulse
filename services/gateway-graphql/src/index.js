'use strict';

// OTel must be the very first import — instruments HTTP + Express automatically
require('@carepack/otel-node');
const { correlationFormat } = require('@carepack/otel-node/correlation');

const fs                    = require('fs');
const path                  = require('path');
const express               = require('express');
const { ApolloServer }      = require('@apollo/server');
const { expressMiddleware }  = require('@apollo/server/express4');
const { createLogger, format, transports } = require('winston');
const { Pool }              = require('pg');
const depthLimit            = require('graphql-depth-limit');
const { createComplexityLimitRule } = require('graphql-query-complexity');

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

// ── Persisted query map ───────────────────────────────────────────────────────
// Maps SHA256 hash → approved query string.
// In production only queries whose hash exists in this map are allowed.
// In development (NODE_ENV !== 'production') all queries pass through so
// engineers can use Apollo Sandbox freely.
//
// To add a new query:
//   1. Write the query string
//   2. Generate its SHA256: echo -n "query ..." | sha256sum
//   3. Add the hash → query entry to persisted-queries.json
//   4. Commit the file — it is the source of truth for what clients can send
const PERSISTED_QUERIES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'persisted-queries.json'), 'utf8')
);
const IS_PROD = process.env.NODE_ENV === 'production';

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

    # Fetch a single patient by ID — tenant-scoped via RLS + explicit filter
    patient(id: String!): PatientSummary

    # Paginated patient list — cursor is patient ID, ordered by updated_at DESC
    patients(first: Int, after: String): [PatientSummary!]!
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
         WHERE id        = $1
           AND tenant_id = $2`,
        [id, ctx.user.tenantId],
      );
      if (!rows.length) return null;
      return mapRow(rows[0]);
    },

    patients: async (_parent, { first = 20, after }, ctx) => {
      // Cursor-based pagination: after = last seen patient ID
      // Encode cursor as base64(id+created_at) in S6 — plain ID for now
      const rows = await ctx.tenantQuery(
        `SELECT id, tenant_id, mrn, full_name, ward, status, news2_score, updated_at
         FROM patient_dashboard_projection
         WHERE tenant_id = $1
           AND ($2::text IS NULL OR updated_at < (
             SELECT updated_at
             FROM   patient_dashboard_projection
             WHERE  id = $2
           ))
         ORDER BY updated_at DESC
         LIMIT    $3`,
        [ctx.user.tenantId, after ?? null, first],
      );
      return rows.map(mapRow);
    },
  },
};

// Maps snake_case DB row → camelCase GraphQL object
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

// ── Validation rules ──────────────────────────────────────────────────────────

// Depth limit — blocks deeply nested queries before they touch the DB.
// Max depth 5 covers all real use cases:
//   patient { alerts { severity } }  = depth 3  ✓
//   patient { alerts { patient { alerts { patient { ... } } } } } = depth 6 ✗
const depthLimitRule = depthLimit(5, {}, (depths) => {
  logger.warn({ msg: 'graphql_depth_limit_exceeded', depths });
});

// Complexity limit — each scalar field costs 1, each list multiplies by 10.
// Prevents "fetch everything" queries even if they're shallow.
// Example costs:
//   patient { id fullName ward }          = 3 points   ✓
//   patients(first: 100) { id fullName }  = 200 points ✗ (100 × 2 fields)
const complexityLimitRule = createComplexityLimitRule(100, {
  scalarCost:  1,
  objectCost:  1,
  listFactor:  10,
  onCost: (cost) => {
    logger.info({ msg: 'graphql_query_complexity', cost });
  },
});

// ── Persisted query plugin ────────────────────────────────────────────────────
// Lifecycle: fires on every request AFTER Apollo parses the query but BEFORE
// resolvers run. That means invalid hashes are rejected with zero DB load.
//
// Client request shape in production:
//   POST /graphql
//   { "extensions": { "persistedQuery": { "sha256Hash": "a3f2c1..." } } }
//
// In development: any query passes through (Apollo Sandbox works normally).
const persistedQueryPlugin = {
  async requestDidStart() {
    return {
      async didResolveOperation({ request }) {
        // Skip enforcement outside production
        if (!IS_PROD) return;

        // Read the hash the client sent
        const hash = request.extensions?.persistedQuery?.sha256Hash;

        // No hash at all — client sent a raw query string → reject
        if (!hash) {
          throw new Error(
            'Persisted queries are required in production. ' +
            'Send { extensions: { persistedQuery: { sha256Hash: "..." } } } ' +
            'instead of a raw query string.',
          );
        }

        // Hash not in our approved map → reject
        if (!PERSISTED_QUERIES[hash]) {
          logger.warn({ msg: 'unknown_persisted_query_hash', hash });
          throw new Error(
            `Unknown persisted query hash: ${hash}. ` +
            'Add the query to persisted-queries.json and redeploy.',
          );
        }

        // Hash is approved — swap in the pre-approved query string.
        // Apollo continues execution as normal with this query.
        request.query = PERSISTED_QUERIES[hash];

        logger.info({ msg: 'persisted_query_resolved', hash });
      },
    };
  },
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main() {
  const app = express();
  app.use(express.json());

  // Health check — no auth required
  app.get('/healthz', (_req, res) => res.sendStatus(200));

  const apollo = new ApolloServer({
    typeDefs,
    resolvers,

    // Validation rules run BEFORE resolvers — bad queries are rejected immediately
    // with no DB calls made
    validationRules: [depthLimitRule, complexityLimitRule],

    plugins: [persistedQueryPlugin],

    // Never leak internal stack traces to clients in production
    formatError: (formattedError, error) => {
      logger.error({ msg: 'graphql_error', error: error?.message });
      if (IS_PROD) {
        return { message: formattedError.message };
      }
      return formattedError;
    },
  });

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
    logger.info({
      msg:               'gateway-graphql listening',
      port,
      env:               process.env.NODE_ENV ?? 'development',
      depth_limit:       5,
      complexity_limit:  100,
      persisted_queries: IS_PROD ? 'enforced' : 'open (dev)',
    });
  });
}

main().catch((err) => {
  logger.error({ msg: 'startup failed', err: err.message });
  process.exit(1);
});
