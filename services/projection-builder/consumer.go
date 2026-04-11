package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog/log"
	"github.com/segmentio/kafka-go"
)

// PatientCreatedPayload matches the outbox event payload written by patient-service.
type PatientCreatedPayload struct {
	PatientID   string `json:"patientId"`
	TenantID    string `json:"tenantId"`
	MRN         string `json:"mrn"`
	FirstName   string `json:"firstName"`
	LastName    string `json:"lastName"`
	DateOfBirth string `json:"dateOfBirth"`
	Ward        string `json:"ward"`
}

// StartConsumer connects to Kafka and Postgres, then runs the consume loop.
// Blocks until ctx is cancelled.
func StartConsumer(ctx context.Context) error {
	brokers := strings.Split(envOrDefault("KAFKA_BROKERS", "localhost:9092"), ",")
	groupID := envOrDefault("KAFKA_GROUP_ID", "projection-builder")
	topic := "patient.created"

	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		GroupID:        groupID,
		Topic:          topic,
		MinBytes:       1,
		MaxBytes:       10e6, // 10 MB
		CommitInterval: time.Second,
		StartOffset:    kafka.FirstOffset,
	})
	defer func() {
		if err := r.Close(); err != nil {
			log.Error().Err(err).Msg("kafka reader close failed")
		}
	}()

	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return fmt.Errorf("pgxpool.New: %w", err)
	}
	defer pool.Close()

	log.Info().Str("topic", topic).Str("group", groupID).Msg("consumer started")

	for {
		msg, err := r.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil // clean shutdown
			}
			log.Error().Err(err).Msg("fetch message failed")
			continue
		}

		if err := handleMessage(ctx, pool, msg); err != nil {
			log.Error().Err(err).Str("topic", msg.Topic).Int64("offset", msg.Offset).
				Msg("message handling failed — will retry")
			continue
		}

		if err := r.CommitMessages(ctx, msg); err != nil {
			log.Error().Err(err).Msg("commit failed")
		}
	}
}

// handleMessage decodes the event and upserts the dashboard projection row.
func handleMessage(ctx context.Context, pool *pgxpool.Pool, msg kafka.Message) error {
	var payload PatientCreatedPayload
	if err := json.Unmarshal(msg.Value, &payload); err != nil {
		return fmt.Errorf("unmarshal payload: %w", err)
	}

	fullName := payload.FirstName + " " + payload.LastName

	_, err := pool.Exec(ctx, `
		INSERT INTO patient_dashboard_projection
			(id, tenant_id, mrn, full_name, ward, status, updated_at)
		VALUES
			($1, $2, $3, $4, $5, 'active', NOW())
		ON CONFLICT (id) DO UPDATE SET
			full_name  = EXCLUDED.full_name,
			ward       = EXCLUDED.ward,
			updated_at = NOW()
	`, payload.PatientID, payload.TenantID, payload.MRN, fullName, nullIfEmpty(payload.Ward))

	if err != nil {
		return fmt.Errorf("upsert projection: %w", err)
	}

	log.Info().
		Str("patient_id", payload.PatientID).
		Str("tenant_id", payload.TenantID).
		Msg("patient_dashboard_projection upserted")

	return nil
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
