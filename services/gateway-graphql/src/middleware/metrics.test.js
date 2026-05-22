const express = require('express');
const http = require('http');

describe('metrics middleware', () => {
  let server;
  let port;

  beforeEach(async () => {
    jest.resetModules();
    const { instrument, metricsHandler } = require('./metrics');
    const app = express();
    app.use(instrument);
    app.get('/ok', (_req, res) => res.sendStatus(200));
    app.get('/boom', (_req, res) => res.sendStatus(500));
    app.get('/metrics', metricsHandler);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    port = server.address().port;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  function get(path) {
    return new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}${path}`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
    });
  }

  it('counts requests and exposes them on /metrics', async () => {
    await get('/ok');
    await get('/ok');
    await get('/boom');
    const { body } = await get('/metrics');
    expect(body).toContain('http_requests_total{');
    expect(body).toMatch(/http_requests_total\{[^}]*code="200"[^}]*\}\s+2/);
    expect(body).toMatch(/http_requests_total\{[^}]*code="500"[^}]*\}\s+1/);
    expect(body).toContain('http_request_duration_seconds_bucket');
    expect(body).toContain('service="gateway-graphql"');
  });
});
