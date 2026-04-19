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

// RiskScoredPayload matches the domain.risk.scored Kafka event.
type RiskScoredPayload struct {
	DeviceID  string  `json:"device_id"`
	PatientID string  `json:"patient_id"`
	TenantID  string  `json:"tenant_id"`
	WardID    string  `json:"ward_id"`
	News2     float64 `json:"news2"`
	Qsofa     float64 `json:"qsofa"`
	RiskLevel string  `json:"risk_level"`
	ScoredAt  string  `json:"scored_at"`
	EmitAlert bool    `json:"emit_alert"`
}

// StartConsumer reads domain.risk.scored and updates both read models.
// Blocks until ctx is cancelled.
func StartConsumer(ctx context.Context) error {
	brokers := strings.Split(envOrDefault("KAFKA_BROKERS", "localhost:9092"), ",")
	groupID := envOrDefault("KAFKA_GROUP_ID", "read-model-builder")
	topic := envOrDefault("KAFKA_TOPIC", "domain.risk.scored")

	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers:        brokers,
		GroupID:        groupID,
		Topic:          topic,
		MinBytes:       1,
		MaxBytes:       10e6,
		CommitInterval: time.Second,
		StartOffset:    kafka.FirstOffset,
	})
	defer r.Close()

	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return fmt.Errorf("pgxpool.New: %w", err)
	}
	defer pool.Close()

	if err := ensureSchema(ctx, pool); err != nil {
		return fmt.Errorf("ensureSchema: %w", err)
	}

	log.Info().Str("topic", topic).Str("group", groupID).Msg("read-model-builder consumer started")

	for {
		msg, err := r.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			log.Error().Err(err).Msg("fetch failed")
			continue
		}

		const maxRetries = 3
		var handleErr error
		for attempt := 1; attempt <= maxRetries; attempt++ {
			if handleErr = handleMessage(ctx, pool, msg); handleErr == nil {
				break
			}
			log.Error().Err(handleErr).
				Int("attempt", attempt).
				Int64("offset", msg.Offset).
				Msg("handle failed, retrying")
			time.Sleep(time.Duration(attempt) * 200 * time.Millisecond)
		}
		if handleErr != nil {
			log.Error().Err(handleErr).Int64("offset", msg.Offset).Msg("max retries exceeded — skipping")
		}

		if err := r.CommitMessages(ctx, msg); err != nil {
			log.Error().Err(err).Msg("commit failed")
		}
	}
}

// handleMessage updates both projections atomically.
func handleMessage(ctx context.Context, pool *pgxpool.Pool, msg kafka.Message) error {
	var p RiskScoredPayload
	if err := json.Unmarshal(msg.Value, &p); err != nil {
		return fmt.Errorf("unmarshal: %w", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// ── 1. Ward Occupancy Projection ─────────────────────────────────────────
	// Tracks per-ward patient counts and critical escalation counts.
	// UPSERT: increment patient_count on first event; update critical_count when
	// risk_level changes. Uses last-write-wins for risk level per patient.
	_, err = tx.Exec(ctx, `
		INSERT INTO ward_occupancy_projection
			(ward_id, tenant_id, patient_count, critical_count, last_updated)
		VALUES ($1, $2, 1,
			CASE WHEN $3 = 'critical' THEN 1 ELSE 0 END,
			NOW())
		ON CONFLICT (ward_id, tenant_id) DO UPDATE SET
			patient_count  = ward_occupancy_projection.patient_count,
			critical_count = (
				SELECT COUNT(*) FROM alerts_by_priority
				WHERE ward_id   = $1
				  AND tenant_id = $2
				  AND risk_level = 'critical'
				  AND scored_at  > NOW() - INTERVAL '1 hour'
			),
			last_updated = NOW()
	`, p.WardID, p.TenantID, p.RiskLevel)
	if err != nil {
		return fmt.Errorf("upsert ward_occupancy: %w", err)
	}

	// ── 2. Alerts By Priority Projection ─────────────────────────────────────
	// Sorted alert feed per tenant — used by GraphQL patients query.
	// Priority order: critical(1) > high(2) > medium(3) > low(4)
	// On conflict (patient_id, tenant_id): update if new score is higher priority
	// or same priority with more recent scored_at.
	_, err = tx.Exec(ctx, `
		INSERT INTO alerts_by_priority
			(patient_id, device_id, tenant_id, ward_id, news2, qsofa,
			 risk_level, priority, scored_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7,
			CASE $7
				WHEN 'critical' THEN 1
				WHEN 'high'     THEN 2
				WHEN 'medium'   THEN 3
				ELSE 4
			END,
			$8::timestamptz)
		ON CONFLICT (patient_id, tenant_id) DO UPDATE SET
			device_id  = EXCLUDED.device_id,
			ward_id    = EXCLUDED.ward_id,
			news2      = EXCLUDED.news2,
			qsofa      = EXCLUDED.qsofa,
			risk_level = EXCLUDED.risk_level,
			priority   = EXCLUDED.priority,
			scored_at  = EXCLUDED.scored_at
		WHERE EXCLUDED.priority < alerts_by_priority.priority
		   OR (EXCLUDED.priority = alerts_by_priority.priority
		       AND EXCLUDED.scored_at > alerts_by_priority.scored_at)
	`, p.PatientID, p.DeviceID, p.TenantID, p.WardID,
		p.News2, p.Qsofa, p.RiskLevel, p.ScoredAt)
	if err != nil {
		return fmt.Errorf("upsert alerts_by_priority: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	log.Info().
		Str("patient_id", p.PatientID).
		Str("ward_id", p.WardID).
		Str("risk_level", p.RiskLevel).
		Float64("news2", p.News2).
		Msg("read_models_updated")

	return nil
}

// ensureSchema creates the two read model tables if they don't exist.
func ensureSchema(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS ward_occupancy_projection (
			ward_id       UUID        NOT NULL,
			tenant_id     UUID        NOT NULL,
			patient_count INT         NOT NULL DEFAULT 0,
			critical_count INT        NOT NULL DEFAULT 0,
			last_updated  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (ward_id, tenant_id)
		);

		CREATE TABLE IF NOT EXISTS alerts_by_priority (
			patient_id  UUID        NOT NULL,
			device_id   UUID        NOT NULL,
			tenant_id   UUID        NOT NULL,
			ward_id     UUID        NOT NULL,
			news2       FLOAT       NOT NULL DEFAULT 0,
			qsofa       FLOAT       NOT NULL DEFAULT 0,
			risk_level  TEXT        NOT NULL,
			priority    INT         NOT NULL,
			scored_at   TIMESTAMPTZ NOT NULL,
			PRIMARY KEY (patient_id, tenant_id)
		);

		CREATE INDEX IF NOT EXISTS idx_alerts_priority_tenant
			ON alerts_by_priority (tenant_id, priority ASC, scored_at DESC);

		CREATE INDEX IF NOT EXISTS idx_ward_occupancy_tenant
			ON ward_occupancy_projection (tenant_id);
	`)
	return err
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
