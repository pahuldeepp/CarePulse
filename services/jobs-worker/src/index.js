'use strict';
require('@carepack/otel-node');
const { correlationFormat } = require('@carepack/otel-node/correlation');

const amqp = require('amqplib');
const express = require('express');
const { createLogger, format, transports } = require('winston');

// ── Logger ────────────────────────────────────────────────────────────────────
const logger = createLogger({
  format: format.combine(correlationFormat(), format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

const RABBITMQ_URL = process.env.RABBITMQ_URL ?? 'amqp://carepack:carepack@localhost:5672/carepack';
const QUEUE       = 'jobs.default';

// ── RabbitMQ consumer ─────────────────────────────────────────────────────────
async function startConsumer() {
  const conn    = await amqp.connect(RABBITMQ_URL);
  const channel = await conn.createChannel();

  // durable queue with dead-letter exchange for failed jobs
  await channel.assertExchange('jobs.dlx', 'direct', { durable: true });
  await channel.assertQueue('jobs.default.dlq', { durable: true });
  await channel.bindQueue('jobs.default.dlq', 'jobs.dlx', QUEUE);
  await channel.assertQueue(QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'jobs.dlx',
      'x-dead-letter-routing-key': QUEUE,
    },
  });

  // prefetch 1 — don't give this worker more than 1 job at a time
  // ensures jobs are distributed evenly across multiple worker instances
  channel.prefetch(1);

  logger.info({ msg: 'jobs-worker consuming', queue: QUEUE });

  channel.consume(QUEUE, async (msg) => {
    if (!msg) return;

    let job;
    try {
      job = JSON.parse(msg.content.toString());
      logger.info({ msg: 'processing job', type: job.type, jobId: job.id });

      // S3: idempotency check against processed_jobs table goes here
      // S3: job handler registry (dispatch by job.type) goes here

      channel.ack(msg);
    } catch (err) {
      logger.error({ msg: 'job failed', err: err.message, job });
      // nack without requeue — dead-letter exchange handles retry
      channel.nack(msg, false, false);
    }
  });
}

// ── Healthcheck server ────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 4001;
const app = express();
app.get('/healthz', (_req, res) => res.sendStatus(200));
app.listen(PORT, () => {
  logger.info({ msg: 'jobs-worker healthcheck listening', port: PORT });
});

// ── Outbox reaper ─────────────────────────────────────────────────────────────
// Runs on a configurable interval (OUTBOX_REAPER_INTERVAL_MS, default 60s).
// Two operations per tick:
//   1. DELETE processed outbox rows older than OUTBOX_TTL_HOURS (default 24h)
//      → prevents unbounded table growth
//   2. Re-publish stuck/pending outbox rows older than OUTBOX_STUCK_THRESHOLD_MS
//      → compensates for Debezium connector downtime or missed CDC events

const { Pool } = require('pg');
const { Kafka } = require('kafkajs');

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://carepack:carepack@localhost:5432/carepack',
  max: 3,
});

const kafka = new Kafka({
  clientId: 'jobs-worker-reaper',
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
});
const kafkaProducer = kafka.producer();
let kafkaReady = false;

async function startOutboxReaper() {
  try {
    await kafkaProducer.connect();
    kafkaReady = true;
    logger.info({ msg: 'outbox_reaper kafka_producer connected' });
  } catch (err) {
    logger.error({ msg: 'outbox_reaper kafka_producer connect failed', err: err.message });
  }

  const intervalMs     = parseInt(process.env.OUTBOX_REAPER_INTERVAL_MS ?? '60000', 10);
  const ttlHours       = parseInt(process.env.OUTBOX_TTL_HOURS ?? '24', 10);
  const stuckThreshMs  = parseInt(process.env.OUTBOX_STUCK_THRESHOLD_MS ?? '30000', 10);

  logger.info({
    msg: 'outbox_reaper started',
    intervalMs,
    ttlHours,
    stuckThreshMs,
  });

  async function tick() {
    try {
      // 1. Purge processed events beyond TTL
      const purgeRes = await pgPool.query(`
        DELETE FROM outbox_events
        WHERE processed = true
          AND created_at < NOW() - INTERVAL '${ttlHours} hours'
      `);
      if (purgeRes.rowCount > 0) {
        logger.info({ msg: 'outbox_reaper purged', rows: purgeRes.rowCount, ttlHours });
      }

      // 2. Re-publish stuck pending events (Debezium missed them or was down)
      if (!kafkaReady) return;
      const stuckRes = await pgPool.query(`
        SELECT id, aggregate_type, aggregate_id, event_type, payload, tenant_id, created_at
        FROM outbox_events
        WHERE processed = false
          AND created_at < NOW() - ($1::int * INTERVAL '1 millisecond')
        ORDER BY created_at ASC
        LIMIT 100
      `, [stuckThreshMs]);

      if (stuckRes.rows.length > 0) {
        logger.warn({ msg: 'outbox_reaper found stuck events', count: stuckRes.rows.length });

        const messages = stuckRes.rows.map((row) => ({
          key: row.aggregate_id,
          value: JSON.stringify(row.payload),
          headers: {
            'event-type':    row.event_type,
            'aggregate-type': row.aggregate_type,
            'tenant-id':     row.tenant_id ?? '',
            'outbox-id':     row.id,
            'reaper-emitted': 'true',
          },
        }));

        await kafkaProducer.send({
          topic: 'cdc.outbox.events',
          messages,
        });

        // Mark as processed so reaper doesn't re-emit on next tick
        const ids = stuckRes.rows.map((r) => r.id);
        await pgPool.query(
          `UPDATE outbox_events SET processed = true WHERE id = ANY($1::uuid[])`,
          [ids],
        );

        logger.info({ msg: 'outbox_reaper re-emitted stuck events', count: messages.length });
      }
    } catch (err) {
      logger.error({ msg: 'outbox_reaper tick failed', err: err.message });
    }
  }

  // Initial tick immediately, then on interval
  await tick();
  // eslint-disable-next-line no-undef
  setInterval(tick, intervalMs);
}

Promise.all([
  startConsumer(),
  startOutboxReaper(),
]).catch((err) => {
  logger.error({ msg: 'startup failed', err: err.message });
  process.exit(1);
});
