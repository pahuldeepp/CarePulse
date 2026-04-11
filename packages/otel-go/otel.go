// Package otelsetup bootstraps the OpenTelemetry SDK for Go services.
//
// Usage (call once at the top of main()):
//
//	shutdown, err := otelsetup.Init(ctx, "telemetry-ingest", "0.1.0")
//	if err != nil { log.Fatal().Err(err).Msg("otel init failed") }
//	defer shutdown(ctx)
//
// Exports a stdout ConsoleExporter.
// S9: swap for OTLP gRPC exporter pointing at the OTel Collector.
package otelsetup

import (
	"context"
	"fmt"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/stdout/stdouttrace"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.25.0"
	oteltrace "go.opentelemetry.io/otel/trace"
)

// Init wires the global TracerProvider with a stdout exporter.
// Returns a shutdown function that must be deferred by the caller.
func Init(ctx context.Context, serviceName, serviceVersion string) (func(context.Context) error, error) {
	if v := os.Getenv("OTEL_SERVICE_NAME"); v != "" {
		serviceName = v
	}

	exporter, err := stdouttrace.New(stdouttrace.WithPrettyPrint())
	if err != nil {
		return nil, fmt.Errorf("otelsetup: create stdout exporter: %w", err)
	}

	res, err := resource.New(ctx,
		resource.WithAttributes(
			semconv.ServiceName(serviceName),
			semconv.ServiceVersion(serviceVersion),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("otelsetup: create resource: %w", err)
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)

	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(
		propagation.NewCompositeTextMapPropagator(
			propagation.TraceContext{},
			propagation.Baggage{},
		),
	)

	return tp.Shutdown, nil
}

// TraceID returns the hex trace ID from the active span in ctx, or "" if none.
// Inject this into zerolog fields for log/trace correlation.
func TraceID(ctx context.Context) string {
	span := oteltrace.SpanFromContext(ctx)
	if !span.SpanContext().IsValid() {
		return ""
	}
	return span.SpanContext().TraceID().String()
}

// SpanID returns the hex span ID from the active span in ctx, or "" if none.
func SpanID(ctx context.Context) string {
	span := oteltrace.SpanFromContext(ctx)
	if !span.SpanContext().IsValid() {
		return ""
	}
	return span.SpanContext().SpanID().String()
}
