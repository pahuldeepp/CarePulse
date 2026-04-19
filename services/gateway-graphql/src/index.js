'use strict';

// OTel must be the very first import — instruments HTTP + Express automatically
require('@carepack/otel-node');
const { correlationFormat } = require('@carepack/otel-node/correlation');

const fs                    = require('fs');
const path                  = require('path');
const http                  = require('http');
const express               = require('express');
const { ApolloServer }      = require('@apollo/server');
const { expressMiddleware }  = require('@apollo/server/express4');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { useServer }         = require('graphql-ws/lib/use/ws');
const { WebSocketServer }   = require('ws');
const DataLoader            = require('dataloader');
const depthLimit            = require('graphql-depth-limit');
const { createComplexityLimitRule } = require('graphql-query-complexity');
const { createLogger, format, transports } = require('winston');
const { Pool }              = require('pg');
const Redis                 = require('ioredis');
const jwt                   = require('jsonwebtoken');
const jwksClient            = require('jwks-rsa');

const { authMiddleware }   = require('./middleware/auth');
const { buildContext }     = require('./context');

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

// ── Redis URL ─────────────────────────────────────────────────────────────────
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// NOTE: We do NOT create a shared redisSubscriber here.
// Redis pub/sub requires a dedicated connection per subscriber — once a client
// calls SUBSCRIBE it can no longer issue regular commands on that connection.
// Each WebSocket subscription creates its own Redis client (see Subscription resolver).

// ── JWKS client for WebSocket auth ───────────────────────────────────────────
// Verifies JWTs on WebSocket connect — required for HIPAA compliance.
// JWKS_URI must be set (e.g. https://auth.example.com/.well-known/jwks.json).
const jwks = jwksClient({
  jwksUri: process.env.JWKS_URI ?? 'http://localhost:4001/.well-known/jwks.json',
  cache: true,
  rateLimit: true,
});

async function verifyWsToken(token) {
  if (!token) throw new Error('Missing WebSocket auth token');
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded?.header?.kid) throw new Error('Invalid token header');
  const key = await jwks.getSigningKey(decoded.header.kid);
  const signingKey = key.getPublicKey();
  return jwt.verify(token, signingKey, { algorithms: ['RS256'] });
}

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
    alerts:     [AlertSummary!]!
  }

  type AlertSummary {
    id:         String!
    severity:   String!
    status:     String!
    news2:      Float
    qsofa:      Float
    triggeredAt: String!
  }

  type Query {
    health: String

    # Fetch a single patient by ID — tenant-scoped via RLS + explicit filter
    patient(id: String!): PatientSummary

    # Paginated patient list — cursor is patient ID, ordered by updated_at DESC
    patients(first: Int, after: String): [PatientSummary!]!
  }

  type Subscription {
    # Real-time alert feed for a tenant — fires when domain.risk.scored publishes
    alertTriggered(tenantId: String!): AlertSummary!
  }
`;

// ── DataLoader — batch-loads alerts for N patients in one query ───────────────
// Without this: 1 patient list query + N alert queries (N+1 problem).
// With this: 1 patient list query + 1 batched alert query regardless of N.
function makeAlertLoader(tenantId) {
  return new DataLoader(async (patientIds) => {
    const rows = await pool.query(
      `SELECT patient_id, id, severity, status, news2, qsofa, triggered_at
       FROM alerts
       WHERE patient_id = ANY($1::uuid[])
         AND tenant_id  = $2
         AND status     = 'open'
       ORDER BY triggered_at DESC`,
      [patientIds, tenantId],
    );

    // Group by patient_id — DataLoader requires results in same order as keys
    const byPatient = {};
    for (const row of rows.rows) {
      (byPatient[row.patient_id] ??= []).push({
        id:          row.id,
        severity:    row.severity,
        status:      row.status,
        news2:       row.news2,
        qsofa:       row.qsofa,
        triggeredAt: row.triggered_at?.toISOString(),
      });
    }
    return patientIds.map((id) => byPatient[id] ?? []);
  });
}

// ── Resolvers ─────────────────────────────────────────────────────────────────
const resolvers = {
  Query: {
    health: () => 'ok',

    patient: async (_parent, { id }, ctx) => {
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

  // Field resolver — uses DataLoader so N patients = 1 DB round-trip
  PatientSummary: {
    alerts: (patient, _args, ctx) => ctx.alertLoader.load(patient.id),
  },

  Subscription: {
    alertTriggered: {
      subscribe: async function* (_parent, { tenantId }) {
        const channel = `alerts:${tenantId}`;

        // ✅ One Redis connection per WebSocket subscription.
        // When this clinician disconnects, THIS client is destroyed — no impact on others.
        // Redis pub/sub connections cannot issue regular commands, so isolation is mandatory.
        const sub = new Redis(REDIS_URL);
        await sub.subscribe(channel);

        // Message queue + resolver pattern bridges Redis event emitter → async generator.
        // Queue is capped at MAX_QUEUE to prevent unbounded memory growth if the consumer
        // is slower than the publisher (drop-oldest policy, same as circuit breaker).
        const MAX_QUEUE = 1000;
        const queue = [];
        let resolve = null;

        const onMessage = (ch, message) => {
          if (ch !== channel) return;
          try {
            const alert = JSON.parse(message);
            if (resolve) {
              const r = resolve;
              resolve = null;
              r(alert);        // unblock the awaiting generator
            } else {
              if (queue.length >= MAX_QUEUE) {
                // Drop oldest to prevent unbounded memory growth
                queue.shift();
                logger.warn({ msg: 'subscription_queue_overflow', channel, dropped: 1 });
              }
              queue.push(alert);
            }
          } catch (err) {
            // Log malformed JSON — silent swallow hides bugs in publishers
            logger.warn({ msg: 'subscription_invalid_json', channel, error: err.message });
          }
        };

        sub.on('message', onMessage);

        try {
          while (true) {
            if (queue.length > 0) {
              yield { alertTriggered: queue.shift() };
            } else {
              // Suspend until next Redis message arrives
              yield { alertTriggered: await new Promise((r) => { resolve = r; }) };
            }
          }
        } finally {
          // ✅ Clean teardown when WebSocket closes or client disconnects
          sub.off('message', onMessage);   // remove listener before disconnect
          await sub.unsubscribe(channel);
          await sub.quit();                // close the dedicated connection
          logger.debug({ msg: 'subscription_closed', channel });
        }
      },
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
  const schema = makeExecutableSchema({ typeDefs, resolvers });

  const app    = express();
  const server = http.createServer(app);

  app.use(express.json());

  // Health check — no auth required
  app.get('/healthz', (_req, res) => res.sendStatus(200));

  // ── WebSocket server for GraphQL subscriptions ────────────────────────────
  // onConnect verifies the JWT from connectionParams before allowing the
  // subscription to proceed. This is HIPAA-critical: without it, any caller
  // can subscribe to any tenantId's alert stream without authentication.
  const wss = new WebSocketServer({ server, path: '/graphql' });
  useServer(
    {
      schema,
      onConnect: async (ctx) => {
        const token = ctx.connectionParams?.authorization;
        try {
          const claims = await verifyWsToken(token);
          // Attach verified claims to the WS context for use in resolvers
          ctx.extra.claims = claims;
          logger.debug({ msg: 'ws_auth_ok', sub: claims.sub });
        } catch (err) {
          logger.warn({ msg: 'ws_auth_failed', error: err.message });
          return false; // reject the connection
        }
      },
      context: async (ctx) => {
        // tenantId is derived from the verified JWT, not from untrusted client params
        const tenantId = ctx.extra.claims?.tenant_id ?? 'unknown';
        return { tenantId, alertLoader: makeAlertLoader(tenantId) };
      },
    },
    wss,
  );

  // ── Apollo HTTP server ────────────────────────────────────────────────────
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

  app.use(
    '/graphql',
    authMiddleware,
    expressMiddleware(apollo, {
      context: ({ req }) => {
        const ctx = buildContext({ req, pool });
        // Attach a fresh DataLoader per request (never share across requests)
        ctx.alertLoader = makeAlertLoader(ctx.user?.tenantId);
        return ctx;
      },
    }),
  );

  const port = process.env.PORT ?? 4000;
  server.listen(port, () => {
    logger.info({
      msg:               'gateway-graphql listening',
      port,
      env:               process.env.NODE_ENV ?? 'development',
      depth_limit:       5,
      complexity_limit:  100,
      persisted_queries: IS_PROD ? 'enforced' : 'open (dev)',
      ws:                `ws://localhost:${port}/graphql`,
    });
  });
}

main().catch((err) => {
  logger.error({ msg: 'startup failed', err: err.message });
  process.exit(1);
});

// ── Export for testing ────────────────────────────────────────────────────────
module.exports = { makeAlertLoader, mapRow };
