package main

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	httpRequests = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name:        "http_requests_total",
			Help:        "HTTP requests, by method/route/code",
			ConstLabels: prometheus.Labels{"service": "telemetry-ingest"},
		},
		[]string{"method", "route", "code"},
	)

	httpDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:        "http_request_duration_seconds",
			Help:        "HTTP request duration in seconds",
			Buckets:     []float64{0.01, 0.03, 0.1, 0.3, 1, 3, 10},
			ConstLabels: prometheus.Labels{"service": "telemetry-ingest"},
		},
		[]string{"method", "route", "code"},
	)
)

type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.code = code
	r.ResponseWriter.WriteHeader(code)
}

func instrument(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, code: 200}
		next.ServeHTTP(rec, r)
		labels := prometheus.Labels{
			"method": r.Method,
			"route":  r.URL.Path,
			"code":   strconv.Itoa(rec.code),
		}
		httpRequests.With(labels).Inc()
		httpDuration.With(labels).Observe(time.Since(start).Seconds())
	})
}
