"""
packages/otel-python — OpenTelemetry SDK bootstrap for all Python (FastAPI) services.

Usage (call before anything else in main.py):
    from packages.otel_python.otel_bootstrap import configure_otel
    configure_otel()

Wires a stdout ConsoleSpanExporter + structlog processor that appends
trace_id and span_id to every log record when an active span exists.

S9: swap ConsoleSpanExporter for OTLPSpanExporter pointing at the Collector.
"""

import os
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource, SERVICE_NAME, SERVICE_VERSION
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, ConsoleSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
import structlog


def configure_otel() -> None:
    """Initialise the OTel SDK and patch structlog with correlation IDs."""
    service_name    = os.getenv("OTEL_SERVICE_NAME", "unknown-service")
    service_version = os.getenv("OTEL_SERVICE_VERSION", "0.0.0")

    provider = TracerProvider(
        resource=Resource.create({
            SERVICE_NAME:    service_name,
            SERVICE_VERSION: service_version,
        })
    )
    # stdout exporter — swap for OTLPSpanExporter in S9
    provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))
    trace.set_tracer_provider(provider)

    # Auto-instrument HTTP clients
    HTTPXClientInstrumentor().instrument()

    # Patch structlog to inject trace_id + span_id on every log call
    structlog.configure(
        processors=[
            _inject_trace_context,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ]
    )


def _inject_trace_context(logger, method, event_dict):  # noqa: ARG001
    """structlog processor — appends OTel trace/span IDs when a span is active."""
    span = trace.get_current_span()
    ctx  = span.get_span_context()
    if ctx and ctx.is_valid:
        event_dict["trace_id"] = format(ctx.trace_id, "032x")
        event_dict["span_id"]  = format(ctx.span_id,  "016x")
    return event_dict


def instrument_fastapi(app) -> None:
    """Call after app = FastAPI(...) to attach OTel middleware."""
    FastAPIInstrumentor.instrument_app(app)
