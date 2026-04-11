'use strict';

const amqp = require('amqplib');
const express = require('express');
const { createLogger, format, transports } = require('winston');

// ── Logger ────────────────────────────────────────────────────────────────────
const logger = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

const RABBITMQ_URL = process.env.RABBITMQ_URL ?? 'amqp://carepack:carepack@localhost:5672/carepack';
const QUEUE       = 'jobs.default';

// ── RabbitMQ consumer ─────────────────────────────────────────────────────────
async function startConsumer() {
  const conn    = await amqp.connect(RABBITMQ_URL);
  const channel = await conn.createChannel();

  // durable queue survives broker restart
  await channel.assertQueue(QUEUE, { durable: true });

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
const app = express();
app.get('/healthz', (_req, res) => res.sendStatus(200));
app.listen(process.env.PORT ?? 4001, () => {
  logger.info({ msg: 'jobs-worker healthcheck listening', port: 4001 });
});

startConsumer().catch((err) => {
  logger.error({ msg: 'consumer startup failed', err: err.message });
  process.exit(1);
});
