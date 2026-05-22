import type { Request, Response, NextFunction } from 'express';
import * as client from 'prom-client';

const SERVICE = process.env.SERVICE_NAME ?? 'billing-service';

export const registry = new client.Registry();
registry.setDefaultLabels({ service: SERVICE });
client.collectDefaultMetrics({ register: registry });

const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests, by method/route/code',
  labelNames: ['method', 'route', 'code'],
  registers: [registry],
});

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'code'],
  buckets: [0.01, 0.03, 0.1, 0.3, 1, 3, 10],
  registers: [registry],
});

export const stripeWebhookProcessed = new client.Counter({
  name: 'stripe_webhook_processed_total',
  help: 'Stripe webhooks processed, by event type and status',
  labelNames: ['event_type', 'status'],
  registers: [registry],
});

export function instrument(req: Request, res: Response, next: NextFunction): void {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = (req as Request & { route?: { path?: string } }).route?.path || req.path || 'unknown';
    const labels = { method: req.method, route, code: String(res.statusCode) };
    end(labels);
    httpRequests.inc(labels);
  });
  next();
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}
