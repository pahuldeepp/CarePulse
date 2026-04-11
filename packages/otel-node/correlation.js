'use strict';

/**
 * correlation.js — injects active OTel trace_id + span_id into Winston log records.
 *
 * Usage:
 *   const { correlationFormat } = require('@carepack/otel-node/correlation');
 *   const logger = createLogger({ format: format.combine(correlationFormat(), format.json()) });
 */

const { format } = require('winston');
const { trace, context } = require('@opentelemetry/api');

/**
 * Winston custom format that appends trace_id and span_id from the active OTel span.
 * If no span is active the fields are omitted (not null) to keep logs clean.
 */
const correlationFormat = format((info) => {
  const span = trace.getActiveSpan();
  if (span) {
    const { traceId, spanId } = span.spanContext();
    if (traceId !== '00000000000000000000000000000000') {
      info.trace_id = traceId;
      info.span_id  = spanId;
    }
  }
  return info;
});

module.exports = { correlationFormat };
