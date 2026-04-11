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

// projection-builder consumes Kafka events and upserts read-model projections.
// Full Kafka consumer wired in S2.

func main() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = log.Output(os.Stdout)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	log.Info().Msg("projection-builder starting")

	// Start Kafka consumer in background goroutine
	go func() {
		if err := StartConsumer(ctx); err != nil {
			log.Fatal().Err(err).Msg("consumer exited with error")
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{Addr: ":8082", Handler: mux}
	go func() {
		log.Info().Str("addr", srv.Addr).Msg("projection-builder listening")
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
	log.Info().Msg("projection-builder stopped")
}
