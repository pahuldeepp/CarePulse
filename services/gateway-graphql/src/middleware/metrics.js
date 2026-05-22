const client = require('prom-client');

const SERVICE = process.env.SERVICE_NAME || 'gateway-graphql';

const registry = new client.Registry();
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

function instrument(req, res, next) {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path || req.path || 'unknown';
    const labels = { method: req.method, route, code: String(res.statusCode) };
    end(labels);
    httpRequests.inc(labels);
  });
  next();
}

async function metricsHandler(_req, res) {
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}

module.exports = { instrument, metricsHandler, registry };
