package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

// saga-orchestrator coordinates multi-step workflows with compensation.
// Saga state stored in Redis with TTL auto-cleanup.
// Device provisioning saga wired in S4.
//
// Flow (S4):
//   1. reserve device slot (asset-registry)
//   2. create patient record (patient-service)
//   3. emit provisioned event (Kafka)
//   compensate: if step 3 fails → delete patient → release slot

func main() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = log.Output(os.Stdout)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	log.Info().Msg("saga-orchestrator starting")

	// S4: Redis saga state store goes here
	// S4: device provisioning saga with TTL auto-cleanup

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{Addr: ":8083", Handler: mux}
	go func() {
		log.Info().Str("addr", srv.Addr).Msg("saga-orchestrator listening")
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("server error")
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	if err := srv.Shutdown(ctx); err != nil {
		log.Error().Err(err).Msg("shutdown failed")
	}
	log.Info().Msg("saga-orchestrator stopped")
}
