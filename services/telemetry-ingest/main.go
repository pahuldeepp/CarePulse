package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

// ── Config ────────────────────────────────────────────────────────────────────

const (
	workerCount  = 50             // goroutines pulling from the queue
	queueSize    = 10_000         // buffered channel capacity (backpressure buffer)
	batchSize    = 500            // rows per pgx COPY batch
	flushEvery   = 100 * time.Millisecond // flush even if batch not full
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
	queue chan Reading   // goroutines talk through this channel
	pool  *pgxpool.Pool // postgres connection pool
	wg    sync.WaitGroup
}

func NewIngestor(pool *pgxpool.Pool) *Ingestor {
	return &Ingestor{
		queue: make(chan Reading, queueSize), // buffered — senders don't block until full
		pool:  pool,
	}
}

// Submit puts a reading onto the queue (non-blocking — drops if full).
// HTTP handlers call this; they never wait for the DB write.
func (ing *Ingestor) Submit(r Reading) bool {
	select {
	case ing.queue <- r:
		return true
	default:
		// queue full — shed load rather than block the HTTP layer
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
	close(ing.queue) // signals workers: no more readings coming
	ing.wg.Wait()
	log.Info().Msg("ingestor stopped cleanly")
}

// runWorker is the core loop for one goroutine.
// It collects readings into a local batch and flushes to Postgres when:
//   - batch reaches batchSize, OR
//   - flushEvery timer fires (so we never hold data too long)
func (ing *Ingestor) runWorker(ctx context.Context, id int) {
	defer ing.wg.Done()

	batch := make([]Reading, 0, batchSize)
	ticker := time.NewTicker(flushEvery)
	defer ticker.Stop()

	logger := log.With().Int("worker", id).Logger()

	for {
		select {

		// ── new reading arrived on the channel ────────────────────────────────
		case r, ok := <-ing.queue:
			if !ok {
				// channel closed — flush whatever is left then exit
				if len(batch) > 0 {
					ing.flush(ctx, batch, logger)
				}
				return
			}
			batch = append(batch, r)
			if len(batch) >= batchSize {
				ing.flush(ctx, batch, logger)
				batch = batch[:0] // reset slice, keep memory
			}

		// ── timer fired — flush partial batch ─────────────────────────────────
		case <-ticker.C:
			if len(batch) > 0 {
				ing.flush(ctx, batch, logger)
				batch = batch[:0]
			}
		}
	}
}

// flush writes a batch to Postgres using COPY — the fastest bulk insert method.
// COPY bypasses row-by-row parsing, WAL overhead is minimal, throughput is ~10x
// faster than individual INSERTs.
func (ing *Ingestor) flush(ctx context.Context, batch []Reading, logger zerolog.Logger) {
	start := time.Now()

	rows := make([][]any, len(batch))
	for i, r := range batch {
		rows[i] = []any{r.DeviceID, r.TenantID, r.Metric, r.Value, r.Timestamp}
	}

	_, err := ing.pool.CopyFrom(
		ctx,
		// table to write into (created by migration in S2)
		pgxPoolIdentifier{"public", "telemetry_readings"},
		[]string{"device_id", "tenant_id", "metric", "value", "timestamp"},
		pgxpool.CopyFromRows(rows),
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

// pgxPoolIdentifier satisfies pgx's pgx.Identifier for table names.
type pgxPoolIdentifier []string

func (id pgxPoolIdentifier) Sanitize() string {
	return fmt.Sprintf("%q.%q", id[0], id[1])
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
			// queue full — tell client to back off
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusAccepted) // 202 — queued, not yet written
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	// structured JSON logging (zerolog)
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = log.Output(os.Stdout)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// postgres connection pool (pgx)
	dsn := getEnv("DATABASE_URL", "postgres://carepack:carepack@localhost:5433/carepack")
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal().Err(err).Msg("failed to connect to postgres")
	}
	defer pool.Close()

	// start the ingestor — launches all goroutines
	ing := NewIngestor(pool)
	ing.Start(ctx)

	// HTTP server
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/readings", handleIngest(ing))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{
		Addr:    ":8080",
		Handler: mux,
	}

	// start server in its own goroutine so main can wait for shutdown signal
	go func() {
		log.Info().Str("addr", srv.Addr).Msg("telemetry-ingest listening")
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("server error")
		}
	}()

	// block until SIGTERM or SIGINT (Ctrl+C / Kubernetes pod shutdown)
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	log.Info().Msg("shutting down...")
	srv.Shutdown(ctx) // stop accepting new requests
	ing.Stop()        // drain queue, flush remaining batches
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
