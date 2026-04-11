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

	// consumerErr receives a non-nil error if the consumer exits unexpectedly.
	// Using a channel instead of log.Fatal avoids killing the process from a goroutine.
	consumerErr := make(chan error, 1)
	go func() {
		if err := StartConsumer(ctx); err != nil {
			consumerErr <- err
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
			log.Error().Err(err).Msg("server error")
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

	select {
	case <-quit:
		log.Info().Msg("shutdown signal received")
	case err := <-consumerErr:
		log.Error().Err(err).Msg("consumer exited with error — shutting down")
		cancel()
	}

	if err := srv.Shutdown(ctx); err != nil {
		log.Error().Err(err).Msg("shutdown failed")
	}
	log.Info().Msg("projection-builder stopped")
}
