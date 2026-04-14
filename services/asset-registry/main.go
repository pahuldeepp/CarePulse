package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"golang.org/x/crypto/bcrypt"
)

var db *pgxpool.Pool

type provisionRequest struct {
	DeviceID   string `json:"device_id"`
	TenantID   string `json:"tenant_id"`
	WardID     string `json:"ward_id"`
	DeviceType string `json:"device_type"`
}

type provisionResponse struct {
	DeviceID string `json:"device_id"`
	APIKey   string `json:"api_key"`
}

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

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealth)
	mux.HandleFunc("POST /v1/devices", handleProvision)
	mux.HandleFunc("GET /v1/devices/{device_id}", handleGetDevice)

	srv := &http.Server{
		Addr:         ":8081",
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Info().Str("addr", srv.Addr).Msg("asset-registry listening")
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("server error")
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
	<-quit

	shutCtx, shutCancel := context.WithTimeout(ctx, 10*time.Second)
	defer shutCancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		log.Error().Err(err).Msg("shutdown error")
	}
	log.Info().Msg("asset-registry stopped")
}

func migrate(ctx context.Context) error {
	_, err := db.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS device_registrations (
			id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
			device_id    TEXT        NOT NULL,
			tenant_id    TEXT        NOT NULL,
			ward_id      TEXT        NOT NULL,
			device_type  TEXT        NOT NULL,
			api_key_hash TEXT        NOT NULL,
			created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
			UNIQUE (device_id, tenant_id)
		);
	`)
	return err
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func handleProvision(w http.ResponseWriter, r *http.Request) {
	var req provisionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}
	if req.DeviceID == "" || req.TenantID == "" || req.WardID == "" || req.DeviceType == "" {
		http.Error(w, "device_id, tenant_id, ward_id, device_type are required", http.StatusBadRequest)
		return
	}

	ctx := r.Context()

	// pg_advisory_lock scoped to device_id hash — prevents duplicate
	// provisioning under concurrent requests for the same device.
	conn, err := db.Acquire(ctx)
	if err != nil {
		log.Error().Err(err).Msg("db acquire failed")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock(hashtext($1))", req.DeviceID); err != nil {
		log.Error().Err(err).Msg("advisory lock failed")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	defer conn.Exec(ctx, "SELECT pg_advisory_unlock(hashtext($1))", req.DeviceID) //nolint:errcheck

	var exists bool
	if err := conn.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM device_registrations WHERE device_id=$1 AND tenant_id=$2)",
		req.DeviceID, req.TenantID,
	).Scan(&exists); err != nil {
		log.Error().Err(err).Msg("existence check failed")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if exists {
		http.Error(w, "device already registered for this tenant", http.StatusConflict)
		return
	}

	// Generate API key: dr_<32 random hex chars> — returned once, never stored.
	rawBytes := make([]byte, 16)
	if _, err := rand.Read(rawBytes); err != nil {
		http.Error(w, "key generation failed", http.StatusInternalServerError)
		return
	}
	apiKey := "dr_" + hex.EncodeToString(rawBytes)

	hash, err := bcrypt.GenerateFromPassword([]byte(apiKey), 12)
	if err != nil {
		http.Error(w, "key hashing failed", http.StatusInternalServerError)
		return
	}

	_, err = conn.Exec(ctx, `
		SET LOCAL app.current_tenant_id = $1;
		INSERT INTO device_registrations (device_id, tenant_id, ward_id, device_type, api_key_hash)
		VALUES ($2, $3, $4, $5, $6)
	`, req.TenantID, req.DeviceID, req.TenantID, req.WardID, req.DeviceType, string(hash))
	if err != nil {
		log.Error().Err(err).Str("device_id", req.DeviceID).Msg("insert failed")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	log.Info().Str("device_id", req.DeviceID).Str("tenant_id", req.TenantID).Msg("device_provisioned")

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(provisionResponse{DeviceID: req.DeviceID, APIKey: apiKey})
}

func handleGetDevice(w http.ResponseWriter, r *http.Request) {
	deviceID := r.PathValue("device_id")
	tenantID := r.Header.Get("X-Tenant-ID")

	var result struct {
		DeviceID   string    `json:"device_id"`
		TenantID   string    `json:"tenant_id"`
		WardID     string    `json:"ward_id"`
		DeviceType string    `json:"device_type"`
		CreatedAt  time.Time `json:"created_at"`
	}

	err := db.QueryRow(r.Context(), `
		SELECT device_id, tenant_id, ward_id, device_type, created_at
		FROM device_registrations
		WHERE device_id = $1 AND tenant_id = $2
	`, deviceID, tenantID).Scan(
		&result.DeviceID, &result.TenantID,
		&result.WardID, &result.DeviceType, &result.CreatedAt,
	)
	if err != nil {
		http.Error(w, "device not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}
