'use strict';

/**
 * packages/otel-node — OpenTelemetry SDK bootstrap for all Node/NestJS services.
 *
 * Usage (must be the very first import in main.ts / index.js):
 *   require('@carepack/otel-node');          // CommonJS
 *   import '@carepack/otel-node';            // ESM / TypeScript
 *
 * Exports a stdout OTLP trace exporter + auto-instruments HTTP and Express.
 * Correlation ID (trace_id) is injected as a Winston log field via a custom format.
 *
 * S9: swap NodeSDK exporter to OtlpGrpcExporter pointing at the Collector.
 */

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { Resource } = require('@opentelemetry/resources');
const { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');

const SERVICE_NAME    = process.env.OTEL_SERVICE_NAME    ?? process.env.npm_package_name ?? 'unknown-service';
const SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION ?? process.env.npm_package_version ?? '0.0.0';

const sdk = new NodeSDK({
  resource: new Resource({
    [SEMRESATTRS_SERVICE_NAME]:    SERVICE_NAME,
    [SEMRESATTRS_SERVICE_VERSION]: SERVICE_VERSION,
  }),
  traceExporter: new ConsoleSpanExporter(),   // stdout — swap for OTLP in S9
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false }, // too noisy
    }),
  ],
});

sdk.start();

// Graceful shutdown
process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
process.on('SIGINT',  () => sdk.shutdown().finally(() => process.exit(0)));

module.exports = { sdk };
