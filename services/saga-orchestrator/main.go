package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"github.com/segmentio/kafka-go"
)

const sagaTTL = 3600 * time.Second

var rdb *redis.Client

type sagaState struct {
	SagaID    string    `json:"saga_id"`
	DeviceID  string    `json:"device_id"`
	TenantID  string    `json:"tenant_id"`
	Step      int       `json:"step"`
	Status    string    `json:"status"`
	StartedAt time.Time `json:"started_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type provisionRequest struct {
	DeviceID   string `json:"device_id"`
	TenantID   string `json:"tenant_id"`
	WardID     string `json:"ward_id"`
	DeviceType string `json:"device_type"`
	PatientMRN string `json:"patient_mrn"`
}

func main() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = log.Output(os.Stdout)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	opt, err := redis.ParseURL(getEnv("REDIS_URL", "redis://localhost:6379"))
	if err != nil {
		log.Fatal().Err(err).Msg("redis parse failed")
	}
	rdb = redis.NewClient(opt)
	defer rdb.Close()

	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("POST /v1/sagas/device-provision", handleProvision)
	mux.HandleFunc("GET /v1/sagas/{saga_id}", handleGetSaga)

	// Port 8085 — avoids collision with Debezium Connect REST API (8088)
	// and other services. saga-orchestrator is the orchestration layer.
	srv := &http.Server{
		Addr:         ":" + port(),
		Handler:      mux,
		ReadTimeout:  35 * time.Second, // saga can take up to 30s across 3 service calls
		WriteTimeout: 35 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Info().Str("addr", srv.Addr).Msg("saga-orchestrator listening")
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
	log.Info().Msg("saga-orchestrator stopped")
}

func port() string {
	if p := os.Getenv("PORT"); p != "" {
		return p
	}
	return "8085"
}

func handleProvision(w http.ResponseWriter, r *http.Request) {
	var req provisionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if req.DeviceID == "" || req.TenantID == "" || req.PatientMRN == "" {
		http.Error(w, "device_id, tenant_id, patient_mrn are required", http.StatusBadRequest)
		return
	}

	sagaID := uuid.New().String()
	state := &sagaState{
		SagaID:    sagaID,
		DeviceID:  req.DeviceID,
		TenantID:  req.TenantID,
		Step:      0,
		Status:    "running",
		StartedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}

	if err := saveSaga(r.Context(), state); err != nil {
		log.Error().Err(err).Str("saga_id", sagaID).Msg("saga_init_save_failed")
		http.Error(w, "failed to init saga", http.StatusInternalServerError)
		return
	}

	failedStep, err := runSaga(r.Context(), sagaID, req, state)
	if err != nil {
		log.Error().Err(err).Str("saga_id", sagaID).Int("failed_at_step", failedStep).Msg("saga_failed")
		compensate(r.Context(), sagaID, req, failedStep)

		state.Status = "failed"
		state.UpdatedAt = time.Now().UTC()
		if saveErr := saveSaga(r.Context(), state); saveErr != nil {
			log.Error().Err(saveErr).Str("saga_id", sagaID).Msg("saga_failed_state_save_error")
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		if encErr := json.NewEncoder(w).Encode(map[string]any{
			"saga_id":        sagaID,
			"status":         "failed",
			"failed_at_step": failedStep,
		}); encErr != nil {
			log.Error().Err(encErr).Msg("encode_saga_error_failed")
		}
		return
	}

	state.Status = "completed"
	state.Step = 3
	state.UpdatedAt = time.Now().UTC()
	if saveErr := saveSaga(r.Context(), state); saveErr != nil {
		log.Error().Err(saveErr).Str("saga_id", sagaID).Msg("saga_completed_state_save_error")
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if encErr := json.NewEncoder(w).Encode(map[string]any{
		"saga_id": sagaID,
		"status":  "completed",
	}); encErr != nil {
		log.Error().Err(encErr).Msg("encode_saga_complete_failed")
	}
}

// runSaga executes the 3-step device provisioning saga.
// Returns (failedStep, error) — failedStep=0 means success.
//
// Flow:
//
//	Step 1: reserve device slot  (asset-registry)
//	Step 2: create patient record (patient-service)
//	Step 3: emit provisioned event (Kafka)
func runSaga(ctx context.Context, sagaID string, req provisionRequest, state *sagaState) (int, error) {
	assetURL := getEnv("ASSET_REGISTRY_URL", "http://localhost:8081")
	patientURL := getEnv("PATIENT_SERVICE_URL", "http://localhost:3001")

	// Step 1 — reserve device slot
	log.Info().Str("saga_id", sagaID).Msg("saga_step1_start")
	body, _ := json.Marshal(map[string]string{
		"device_id": req.DeviceID, "tenant_id": req.TenantID,
		"ward_id": req.WardID, "device_type": req.DeviceType,
	})
	resp, err := http.Post(assetURL+"/v1/devices", "application/json", bytes.NewReader(body))
	if err != nil {
		return 1, fmt.Errorf("step1 asset-registry unreachable: %w", err)
	}
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusConflict {
		return 1, fmt.Errorf("step1 asset-registry returned %d", resp.StatusCode)
	}
	state.Step = 1
	state.UpdatedAt = time.Now().UTC()
	if saveErr := saveSaga(ctx, state); saveErr != nil {
		log.Error().Err(saveErr).Str("saga_id", sagaID).Int("step", 1).Msg("saga_step_save_error")
	}
	log.Info().Str("saga_id", sagaID).Msg("saga_step1_complete")

	// Step 2 — create patient record
	log.Info().Str("saga_id", sagaID).Msg("saga_step2_start")
	body, _ = json.Marshal(map[string]string{
		"mrn": req.PatientMRN, "tenant_id": req.TenantID,
	})
	preq, _ := http.NewRequestWithContext(ctx, http.MethodPost, patientURL+"/v1/patients", bytes.NewReader(body))
	preq.Header.Set("Content-Type", "application/json")
	preq.Header.Set("X-Tenant-ID", req.TenantID)
	presp, err := http.DefaultClient.Do(preq)
	if err != nil {
		return 2, fmt.Errorf("step2 patient-service unreachable: %w", err)
	}
	if presp.StatusCode != http.StatusCreated {
		return 2, fmt.Errorf("step2 patient-service returned %d", presp.StatusCode)
	}
	state.Step = 2
	state.UpdatedAt = time.Now().UTC()
	if saveErr := saveSaga(ctx, state); saveErr != nil {
		log.Error().Err(saveErr).Str("saga_id", sagaID).Int("step", 2).Msg("saga_step_save_error")
	}
	log.Info().Str("saga_id", sagaID).Msg("saga_step2_complete")

	// Step 3 — emit provisioned event to Kafka
	log.Info().Str("saga_id", sagaID).Msg("saga_step3_start")
	if err := publishProvisioned(ctx, sagaID, req.DeviceID, req.TenantID); err != nil {
		return 3, fmt.Errorf("step3 kafka publish failed: %w", err)
	}
	log.Info().Str("saga_id", sagaID).Msg("saga_step3_complete")

	return 0, nil
}

// compensate rolls back completed steps in reverse order.
func compensate(ctx context.Context, sagaID string, req provisionRequest, failedAtStep int) {
	log.Warn().Str("saga_id", sagaID).Int("failed_at_step", failedAtStep).Msg("saga_compensating")
	assetURL := getEnv("ASSET_REGISTRY_URL", "http://localhost:8081")

	if failedAtStep >= 2 {
		dreq, _ := http.NewRequestWithContext(ctx, http.MethodDelete,
			assetURL+"/v1/devices/"+req.DeviceID, nil)
		dreq.Header.Set("X-Tenant-ID", req.TenantID)
		http.DefaultClient.Do(dreq) //nolint:errcheck
		log.Info().Str("saga_id", sagaID).Msg("saga_compensation_device_released")
	}
}

func publishProvisioned(ctx context.Context, sagaID, deviceID, tenantID string) error {
	w := &kafka.Writer{
		Addr:  kafka.TCP(getEnv("KAFKA_BOOTSTRAP", "localhost:9092")),
		Topic: "domain.device.provisioned",
	}
	defer w.Close()

	payload, _ := json.Marshal(map[string]string{
		"saga_id":     sagaID,
		"device_id":   deviceID,
		"tenant_id":   tenantID,
		"occurred_at": time.Now().UTC().Format(time.RFC3339),
	})

	return w.WriteMessages(ctx, kafka.Message{Value: payload})
}

func handleGetSaga(w http.ResponseWriter, r *http.Request) {
	sagaID := r.PathValue("saga_id")
	val, err := rdb.Get(r.Context(), sagaKey(sagaID)).Result()
	if err == redis.Nil {
		http.Error(w, "saga not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(val)) //nolint:errcheck
}

func saveSaga(ctx context.Context, s *sagaState) error {
	b, _ := json.Marshal(s)
	return rdb.Set(ctx, sagaKey(s.SagaID), b, sagaTTL).Err()
}

func sagaKey(id string) string { return "saga:device:" + id }

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
