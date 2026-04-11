'use strict';

const amqp = require('amqplib');
const express = require('express');
const { createLogger, format, transports } = require('winston');

// ── Logger ────────────────────────────────────────────────────────────────────
const logger = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

const RABBITMQ_URL    = process.env.RABBITMQ_URL ?? 'amqp://carepack:carepack@localhost:5672/carepack';
const EMAIL_QUEUE     = 'email.send';
const ALERT_QUEUE     = 'alert.notify';

// ── Dispatch stubs (S3: wired to SendGrid + Twilio) ───────────────────────────
async function sendEmail(payload) {
  // S3: SendGrid SDK call + template rendering goes here
  logger.info({ msg: 'email stub', to: payload.to, subject: payload.subject });
}

async function sendAlert(payload) {
  // S3: Twilio SMS stub goes here
  logger.info({ msg: 'alert stub', channel: payload.channel, recipient: payload.recipient });
}

// ── Consumer ──────────────────────────────────────────────────────────────────
async function startConsumer() {
  const conn    = await amqp.connect(RABBITMQ_URL);
  const channel = await conn.createChannel();

  await channel.assertExchange('notifications.dlx', 'direct', { durable: true });
  await channel.assertQueue('email.send.dlq', { durable: true });
  await channel.assertQueue('alert.notify.dlq', { durable: true });
  await channel.bindQueue('email.send.dlq', 'notifications.dlx', EMAIL_QUEUE);
  await channel.bindQueue('alert.notify.dlq', 'notifications.dlx', ALERT_QUEUE);
  await channel.assertQueue(EMAIL_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'notifications.dlx',
      'x-dead-letter-routing-key': EMAIL_QUEUE,
    },
  });
  await channel.assertQueue(ALERT_QUEUE, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'notifications.dlx',
      'x-dead-letter-routing-key': ALERT_QUEUE,
    },
  });

  channel.prefetch(10); // notification-svc can handle more concurrency than jobs-worker

  const handle = (handler) => async (msg) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString());
      await handler(payload);
      channel.ack(msg);
    } catch (err) {
      logger.error({ msg: 'notification failed', err: err.message });
      channel.nack(msg, false, false);
    }
  };

  channel.consume(EMAIL_QUEUE, handle(sendEmail));
  channel.consume(ALERT_QUEUE, handle(sendAlert));

  logger.info({ msg: 'notification-svc consuming', queues: [EMAIL_QUEUE, ALERT_QUEUE] });
}

// ── Healthcheck ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 4002;
const app = express();
app.get('/healthz', (_req, res) => res.sendStatus(200));
app.listen(PORT, () => {
  logger.info({ msg: 'notification-svc listening', port: PORT });
});

startConsumer().catch((err) => {
  logger.error({ msg: 'consumer startup failed', err: err.message });
  process.exit(1);
});
