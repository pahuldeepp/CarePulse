package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

// ── Config ────────────────────────────────────────────────────────────────────

const (
	workerCount = 50                    // goroutines pulling from the queue
	queueSize   = 10_000               // buffered channel capacity (backpressure buffer)
	batchSize   = 500                  // rows per pgx COPY batch
	flushEvery  = 100 * time.Millisecond // flush even if batch not full
)

// ── Domain ────────────────────────────────────────────────────────────────────

type Reading struct {
	DeviceID  string    `json:"device_id"`
	TenantID  string    `json:"tenant_id"`
	Metric    string    `json:"metric"`
	Value     float64   `json:"value"`
	Timestamp time.Time `json:"timestamp"`
}

// ── Ingestor ──────────────────────────────────────────────────────────────────

type Ingestor struct {
	queue chan Reading
	pool  *pgxpool.Pool
	wg    sync.WaitGroup
}

func NewIngestor(pool *pgxpool.Pool) *Ingestor {
	return &Ingestor{
		queue: make(chan Reading, queueSize),
		pool:  pool,
	}
}

// Submit puts a reading onto the queue (non-blocking — drops if full).
func (ing *Ingestor) Submit(r Reading) bool {
	select {
	case ing.queue <- r:
		return true
	default:
		log.Warn().Str("device_id", r.DeviceID).Msg("queue full, reading dropped")
		return false
	}
}

// Start launches workerCount goroutines, each running a batch loop.
func (ing *Ingestor) Start(ctx context.Context) {
	for i := range workerCount {
		ing.wg.Add(1)
		go ing.runWorker(ctx, i)
	}
	log.Info().Int("workers", workerCount).Int("queue_cap", queueSize).Msg("ingestor started")
}

// Stop drains remaining readings and waits for all workers to finish.
func (ing *Ingestor) Stop() {
	close(ing.queue)
	ing.wg.Wait()
	log.Info().Msg("ingestor stopped cleanly")
}

func (ing *Ingestor) runWorker(ctx context.Context, id int) {
	defer ing.wg.Done()

	batch := make([]Reading, 0, batchSize)
	ticker := time.NewTicker(flushEvery)
	defer ticker.Stop()

	logger := log.With().Int("worker", id).Logger()

	for {
		select {
		case r, ok := <-ing.queue:
			if !ok {
				if len(batch) > 0 {
					ing.flush(ctx, batch, logger)
				}
				return
			}
			batch = append(batch, r)
			if len(batch) >= batchSize {
				ing.flush(ctx, batch, logger)
				batch = batch[:0]
			}
		case <-ticker.C:
			if len(batch) > 0 {
				ing.flush(ctx, batch, logger)
				batch = batch[:0]
			}
		}
	}
}

// flush writes a batch to Postgres using COPY — fastest bulk insert method.
func (ing *Ingestor) flush(ctx context.Context, batch []Reading, logger zerolog.Logger) {
	start := time.Now()

	rows := make([][]any, len(batch))
	for i, r := range batch {
		rows[i] = []any{r.DeviceID, r.TenantID, r.Metric, r.Value, r.Timestamp}
	}

	_, err := ing.pool.CopyFrom(
		ctx,
		pgx.Identifier{"public", "telemetry_readings"},
		[]string{"device_id", "tenant_id", "metric", "value", "timestamp"},
		pgx.CopyFromRows(rows),
	)
	if err != nil {
		logger.Error().Err(err).Int("batch_size", len(batch)).Msg("flush failed")
		return
	}

	logger.Info().
		Int("rows", len(batch)).
		Dur("took", time.Since(start)).
		Msg("batch flushed")
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

func handleIngest(ing *Ingestor) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var reading Reading
		if err := json.NewDecoder(r.Body).Decode(&reading); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		if reading.Timestamp.IsZero() {
			reading.Timestamp = time.Now().UTC()
		}
		if !ing.Submit(reading) {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = log.Output(os.Stdout)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	dsn := getEnv("DATABASE_URL", "postgres://carepack:carepack@localhost:5433/carepack")
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to connect to postgres")
	}
	defer pool.Close()

	ing := NewIngestor(pool)
	ing.Start(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/readings", handleIngest(ing))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{
		Addr:         ":8080",
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Info().Str("addr", srv.Addr).Msg("telemetry-ingest listening")
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("server error")
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	log.Info().Msg("shutting down...")
	shutCtx, shutCancel := context.WithTimeout(ctx, 10*time.Second)
	defer shutCancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		log.Error().Err(err).Msg("shutdown error")
	}
	ing.Stop()
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
