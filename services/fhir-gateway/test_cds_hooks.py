"""Tests for CDS Hooks endpoint — risk-engine integration."""

from unittest.mock import AsyncMock, MagicMock

from fastapi.testclient import TestClient
from main import app

client = TestClient(app)


def _mock_http(status: int, json_body: dict):
    mock_resp = MagicMock()
    mock_resp.status_code = status
    mock_resp.json.return_value = json_body
    mock_client = MagicMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    return mock_client


def test_cds_discovery_lists_service():
    resp = client.get("/cds-services")
    assert resp.status_code == 200
    services = resp.json()["services"]
    assert any(s["id"] == "carepack-risk-alert" for s in services)


def test_cds_hook_no_telemetry_returns_empty_cards():
    resp = client.post(
        "/cds-services/carepack-risk-alert",
        json={"context": {}},
        headers={"X-Tenant-ID": "t-1"},
    )
    assert resp.status_code == 200
    assert resp.json()["cards"] == []


def test_cds_hook_low_risk_returns_empty_cards():
    import main as m

    mock_http = _mock_http(200, {"news2": 1, "qsofa": 0, "risk_level": "low"})
    m.http_client = mock_http

    resp = client.post(
        "/cds-services/carepack-risk-alert",
        json={"context": {"telemetry": {"device_id": "d-1", "tenant_id": "t-1"}}},
        headers={"X-Tenant-ID": "t-1"},
    )
    assert resp.status_code == 200
    assert resp.json()["cards"] == []


def test_cds_hook_critical_returns_card():
    import main as m

    mock_http = _mock_http(200, {"news2": 8, "qsofa": 2, "risk_level": "critical"})
    m.http_client = mock_http

    resp = client.post(
        "/cds-services/carepack-risk-alert",
        json={"context": {"telemetry": {"device_id": "d-1", "tenant_id": "t-1"}}},
        headers={"X-Tenant-ID": "t-1"},
    )
    assert resp.status_code == 200
    cards = resp.json()["cards"]
    assert len(cards) == 1
    assert cards[0]["indicator"] == "critical"
    assert "NEWS2=8" in cards[0]["summary"]


def test_cds_hook_high_risk_returns_warning_card():
    import main as m

    mock_http = _mock_http(200, {"news2": 5, "qsofa": 1, "risk_level": "high"})
    m.http_client = mock_http

    resp = client.post(
        "/cds-services/carepack-risk-alert",
        json={"context": {"telemetry": {"device_id": "d-1", "tenant_id": "t-1"}}},
        headers={"X-Tenant-ID": "t-1"},
    )
    assert resp.status_code == 200
    cards = resp.json()["cards"]
    assert len(cards) == 1
    assert cards[0]["indicator"] == "warning"


def test_cds_hook_risk_engine_error_returns_empty_cards():
    import httpx
    import main as m

    mock_client = MagicMock()
    mock_client.post = AsyncMock(side_effect=httpx.ConnectError("connection refused"))
    m.http_client = mock_client

    resp = client.post(
        "/cds-services/carepack-risk-alert",
        json={"context": {"telemetry": {"device_id": "d-1", "tenant_id": "t-1"}}},
        headers={"X-Tenant-ID": "t-1"},
    )
    assert resp.status_code == 200
    assert resp.json()["cards"] == []
