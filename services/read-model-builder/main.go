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
	"github.com/segmentio/kafka-go"
)

var db *pgxpool.Pool

func main() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = log.Output(os.Stdout)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var err error
	db, err = pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal().Err(err).Msg("db connect failed")
	}
	defer db.Close()

	if err := migrate(ctx); err != nil {
		log.Fatal().Err(err).Msg("migration failed")
	}

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		consumePatientEvents(ctx)
	}()

	go func() {
		defer wg.Done()
		consumeRiskEvents(ctx)
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	srv := &http.Server{Addr: ":8085", Handler: mux}
	go func() {
		log.Info().Str("addr", srv.Addr).Msg("read-model-builder listening")
		srv.ListenAndServe() //nolint:errcheck
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	cancel()
	wg.Wait()

	shutCtx, shutCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutCancel()
	srv.Shutdown(shutCtx) //nolint:errcheck
	log.Info().Msg("read-model-builder stopped")
}

func migrate(ctx context.Context) error {
	_, err := db.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS patient_dashboard_projection (
			patient_id   TEXT        PRIMARY KEY,
			tenant_id    TEXT        NOT NULL,
			mrn          TEXT,
			full_name    TEXT,
			ward_id      TEXT,
			last_updated TIMESTAMPTZ NOT NULL DEFAULT now()
		);

		CREATE TABLE IF NOT EXISTS patient_risk_latest (
			device_id  TEXT        NOT NULL,
			tenant_id  TEXT        NOT NULL,
			news2      INT         NOT NULL,
			qsofa      INT         NOT NULL,
			risk_level TEXT        NOT NULL,
			scored_at  TIMESTAMPTZ NOT NULL,
			PRIMARY KEY (device_id, tenant_id)
		);

		CREATE TABLE IF NOT EXISTS processed_events (
			event_id     TEXT        PRIMARY KEY,
			processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
		);
	`)
	return err
}

// consumePatientEvents — domain.patient.created → patient_dashboard_projection
func consumePatientEvents(ctx context.Context) {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{getEnv("KAFKA_BOOTSTRAP", "localhost:9092")},
		Topic:   "domain.patient.created",
		GroupID: "projection-builder-patient",
	})
	defer r.Close()

	log.Info().Str("topic", "domain.patient.created").Msg("consumer_started")

	for {
		msg, err := r.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Error().Err(err).Msg("fetch_patient_event_failed")
			continue
		}

		var payload struct {
			PatientID string `json:"patient_id"`
			TenantID  string `json:"tenant_id"`
			MRN       string `json:"mrn"`
			FullName  string `json:"full_name"`
			WardID    string `json:"ward_id"`
		}
		if err := json.Unmarshal(msg.Value, &payload); err != nil {
			log.Error().Err(err).Msg("invalid_patient_event")
			r.CommitMessages(ctx, msg) //nolint:errcheck
			continue
		}

		eventID := fmt.Sprintf("patient:%d:%d", msg.Partition, msg.Offset)
		if err := upsertPatientProjection(ctx, eventID, payload.PatientID, payload.TenantID, payload.MRN, payload.FullName, payload.WardID); err != nil {
			log.Error().Err(err).Str("patient_id", payload.PatientID).Msg("upsert_patient_projection_failed")
			continue
		}

		r.CommitMessages(ctx, msg) //nolint:errcheck
		log.Info().Str("patient_id", payload.PatientID).Str("event_id", eventID).Msg("patient_projection_updated")
	}
}

func upsertPatientProjection(ctx context.Context, eventID, patientID, tenantID, mrn, fullName, wardID string) error {
	var inserted bool
	err := db.QueryRow(ctx,
		`INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING true`,
		eventID,
	).Scan(&inserted)
	if err != nil || !inserted {
		return nil // already processed — idempotent
	}

	_, err = db.Exec(ctx, `
		INSERT INTO patient_dashboard_projection (patient_id, tenant_id, mrn, full_name, ward_id, last_updated)
		VALUES ($1, $2, $3, $4, $5, now())
		ON CONFLICT (patient_id) DO UPDATE SET
			full_name    = EXCLUDED.full_name,
			ward_id      = EXCLUDED.ward_id,
			last_updated = now()
	`, patientID, tenantID, mrn, fullName, wardID)
	return err
}

// consumeRiskEvents — domain.risk.scored → patient_risk_latest (S4)
func consumeRiskEvents(ctx context.Context) {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{getEnv("KAFKA_BOOTSTRAP", "localhost:9092")},
		Topic:   "domain.risk.scored",
		GroupID: "projection-builder-risk",
	})
	defer r.Close()

	log.Info().Str("topic", "domain.risk.scored").Msg("consumer_started")

	for {
		msg, err := r.FetchMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Error().Err(err).Msg("fetch_risk_event_failed")
			continue
		}

		var payload struct {
			DeviceID  string `json:"device_id"`
			TenantID  string `json:"tenant_id"`
			NEWS2     int    `json:"news2"`
			QSOFA     int    `json:"qsofa"`
			RiskLevel string `json:"risk_level"`
			ScoredAt  string `json:"scored_at"`
		}
		if err := json.Unmarshal(msg.Value, &payload); err != nil {
			log.Error().Err(err).Msg("invalid_risk_event")
			r.CommitMessages(ctx, msg) //nolint:errcheck
			continue
		}

		eventID := fmt.Sprintf("risk:%d:%d", msg.Partition, msg.Offset)
		if err := upsertRiskLatest(ctx, eventID, payload.DeviceID, payload.TenantID, payload.NEWS2, payload.QSOFA, payload.RiskLevel, payload.ScoredAt); err != nil {
			log.Error().Err(err).Str("device_id", payload.DeviceID).Msg("upsert_risk_latest_failed")
			continue
		}

		r.CommitMessages(ctx, msg) //nolint:errcheck
		log.Info().Str("device_id", payload.DeviceID).Str("risk_level", payload.RiskLevel).Msg("risk_projection_updated")
	}
}

func upsertRiskLatest(ctx context.Context, eventID, deviceID, tenantID string, news2, qsofa int, riskLevel, scoredAt string) error {
	var inserted bool
	err := db.QueryRow(ctx,
		`INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING true`,
		eventID,
	).Scan(&inserted)
	if err != nil || !inserted {
		return nil // already processed — idempotent
	}

	_, err = db.Exec(ctx, `
		INSERT INTO patient_risk_latest (device_id, tenant_id, news2, qsofa, risk_level, scored_at)
		VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
		ON CONFLICT (device_id, tenant_id) DO UPDATE SET
			news2      = EXCLUDED.news2,
			qsofa      = EXCLUDED.qsofa,
			risk_level = EXCLUDED.risk_level,
			scored_at  = EXCLUDED.scored_at
	`, deviceID, tenantID, news2, qsofa, riskLevel, scoredAt)
	return err
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
