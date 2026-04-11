package main

import (
	"context"
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

	// S2: Kafka consumer loop goes here
	// topics: domain.patient.created, domain.telemetry.ingested
	// action: upsert patient_dashboard_projection in Postgres

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	log.Info().Msg("projection-builder stopped")
	_ = ctx
}
