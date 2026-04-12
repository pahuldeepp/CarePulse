package main

import (
	"testing"
)

func TestNullIfEmpty(t *testing.T) {
	t.Run("returns nil for empty string", func(t *testing.T) {
		result := nullIfEmpty("")
		if result != nil {
			t.Errorf("expected nil, got %v", result)
		}
	})

	t.Run("returns pointer for non-empty string", func(t *testing.T) {
		result := nullIfEmpty("ICU")
		if result == nil {
			t.Fatal("expected non-nil pointer")
		}
		if *result != "ICU" {
			t.Errorf("expected 'ICU', got '%s'", *result)
		}
	})
}

func TestEnvOrDefault(t *testing.T) {
	t.Run("returns fallback when env not set", func(t *testing.T) {
		result := envOrDefault("NONEXISTENT_VAR_XYZ", "fallback-value")
		if result != "fallback-value" {
			t.Errorf("expected 'fallback-value', got '%s'", result)
		}
	})

	t.Run("returns env value when set", func(t *testing.T) {
		t.Setenv("TEST_BROKER_VAR", "broker:9092")
		result := envOrDefault("TEST_BROKER_VAR", "fallback")
		if result != "broker:9092" {
			t.Errorf("expected 'broker:9092', got '%s'", result)
		}
	})
}

func TestPatientCreatedPayload_FullName(t *testing.T) {
	payload := PatientCreatedPayload{
		PatientID: "p-1",
		TenantID:  "t-1",
		MRN:       "MRN-001",
		FirstName: "John",
		LastName:  "Doe",
		Ward:      "ICU",
	}

	fullName := payload.FirstName + " " + payload.LastName
	if fullName != "John Doe" {
		t.Errorf("expected 'John Doe', got '%s'", fullName)
	}
}
