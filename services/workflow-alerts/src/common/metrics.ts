import type { Request, Response, NextFunction } from 'express';
import * as client from 'prom-client';

const SERVICE = process.env.SERVICE_NAME ?? 'workflow-alerts';

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

export const alertsCreated = new client.Counter({
  name: 'alerts_created_total',
  help: 'Alerts created by workflow-alerts consumer',
  labelNames: ['severity', 'status'],
  registers: [registry],
});

export const alertAckDuration = new client.Histogram({
  name: 'alert_ack_duration_seconds',
  help: 'Time from POST /ack to Postgres + outbox commit',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
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
