"""Tests for FHIR R4 schema validation — Pydantic models and endpoint shapes."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi.testclient import TestClient
from main import FHIRBundle, FHIRObservation, FHIRPatient, app
from pydantic import ValidationError

client = TestClient(app)

# ── FHIRPatient ───────────────────────────────────────────────────────────────


def test_fhir_patient_requires_id():
    with pytest.raises(ValidationError):
        FHIRPatient(resourceType="Patient")  # missing id


def test_fhir_patient_default_resource_type():
    p = FHIRPatient(id="p-1")
    assert p.resourceType == "Patient"


def test_fhir_patient_accepts_valid_identifier():
    p = FHIRPatient(
        id="p-1",
        identifier=[{"system": "urn:carepack:mrn", "value": "MRN-001"}],
    )
    assert p.identifier[0]["value"] == "MRN-001"


def test_fhir_patient_name_structure():
    p = FHIRPatient(id="p-1", name=[{"text": "Jane Doe"}])
    assert p.name[0]["text"] == "Jane Doe"


def test_fhir_patient_optional_fields_default_none():
    p = FHIRPatient(id="p-1")
    assert p.birthDate is None
    assert p.gender is None


# ── FHIRObservation ───────────────────────────────────────────────────────────


def test_fhir_observation_requires_subject():
    with pytest.raises(ValidationError):
        FHIRObservation(id="o-1", effectiveDateTime="2026-04-14T10:00:00Z")


def test_fhir_observation_requires_effective_datetime():
    with pytest.raises(ValidationError):
        FHIRObservation(id="o-1", subject={"reference": "Patient/p-1"})


def test_fhir_observation_default_status_is_final():
    o = FHIRObservation(
        id="o-1",
        subject={"reference": "Patient/p-1"},
        effectiveDateTime="2026-04-14T10:00:00Z",
    )
    assert o.status == "final"


def test_fhir_observation_value_quantity_optional():
    o = FHIRObservation(
        id="o-1",
        subject={"reference": "Patient/p-1"},
        effectiveDateTime="2026-04-14T10:00:00Z",
    )
    assert o.valueQuantity is None


# ── FHIRBundle ────────────────────────────────────────────────────────────────


def test_fhir_bundle_requires_type():
    with pytest.raises(ValidationError):
        FHIRBundle()  # missing type


def test_fhir_bundle_default_resource_type():
    b = FHIRBundle(type="document")
    assert b.resourceType == "Bundle"


def test_fhir_bundle_entry_defaults_empty():
    b = FHIRBundle(type="document")
    assert b.entry == []


# ── CDS Hooks discovery ───────────────────────────────────────────────────────


def test_cds_discovery_returns_services_list():
    resp = client.get("/cds-services")
    assert resp.status_code == 200
    assert "services" in resp.json()


def test_cds_discovery_has_carepack_risk_alert():
    resp = client.get("/cds-services")
    ids = [s["id"] for s in resp.json()["services"]]
    assert "carepack-risk-alert" in ids


def test_cds_discovery_hook_is_patient_view():
    resp = client.get("/cds-services")
    hooks = [s["hook"] for s in resp.json()["services"]]
    assert "patient-view" in hooks


# ── Patient endpoint (mocked httpx) ──────────────────────────────────────────


def test_get_patient_maps_to_fhir_format():
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "id": "p-1",
        "mrn": "MRN-001",
        "full_name": "Jane Doe",
        "date_of_birth": "1985-03-15",
        "gender": "female",
    }

    with patch("main.http_client") as mock_client:
        mock_client.get = AsyncMock(return_value=mock_response)
        resp = client.get("/fhir/R4/Patient/p-1", headers={"X-Tenant-ID": "t-1"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["resourceType"] == "Patient"
    assert body["id"] == "p-1"


def test_get_patient_returns_404_when_not_found():
    mock_response = MagicMock()
    mock_response.status_code = 404

    with patch("main.http_client") as mock_client:
        mock_client.get = AsyncMock(return_value=mock_response)
        resp = client.get("/fhir/R4/Patient/missing", headers={"X-Tenant-ID": "t-1"})

    assert resp.status_code == 404


def test_get_patient_returns_502_on_connection_error():
    with patch("main.http_client") as mock_client:
        mock_client.get = AsyncMock(side_effect=httpx.ConnectError("refused"))
        resp = client.get("/fhir/R4/Patient/p-1", headers={"X-Tenant-ID": "t-1"})

    assert resp.status_code == 502
