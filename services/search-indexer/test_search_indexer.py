"""Tests for search-indexer event routing and BulkIndexer."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from main import BulkIndexer, route_event

# ── route_event ───────────────────────────────────────────────────────────────


def test_patient_created_routes_to_patients_index():
    result = route_event(
        "domain.patient.created",
        {
            "patientId": "p-1",
            "tenantId": "t-1",
            "mrn": "MRN001",
            "firstName": "Jane",
            "lastName": "Doe",
            "ward": "ICU",
        },
    )
    assert result is not None
    index, doc_id, doc = result
    assert index == "carepack-patients"
    assert doc_id == "p-1"
    assert doc["name"] == "Jane Doe"
    assert doc["mrn"] == "MRN001"
    assert doc["ward"] == "ICU"


def test_patient_updated_routes_to_patients_index():
    result = route_event(
        "domain.patient.updated",
        {
            "patientId": "p-2",
            "tenantId": "t-1",
            "mrn": "MRN002",
            "firstName": "John",
            "lastName": "Smith",
        },
    )
    assert result is not None
    assert result[0] == "carepack-patients"
    assert result[1] == "p-2"


def test_risk_scored_critical_routes_to_alerts_index():
    result = route_event(
        "domain.risk.scored",
        {
            "device_id": "d-1",
            "tenant_id": "t-1",
            "risk_level": "critical",
            "emit_alert": True,
            "news2": 8,
            "qsofa": 2,
            "scored_at": "2026-04-23T00:00:00Z",
        },
    )
    assert result is not None
    index, _, doc = result
    assert index == "carepack-alerts"
    assert doc["severity"] == "critical"
    assert doc["news2"] == 8


def test_risk_scored_high_routes_to_alerts_index():
    result = route_event(
        "domain.risk.scored",
        {
            "device_id": "d-2",
            "tenant_id": "t-1",
            "risk_level": "high",
            "emit_alert": True,
            "news2": 6,
            "qsofa": 1,
            "scored_at": "2026-04-23T00:00:00Z",
        },
    )
    assert result is not None
    assert result[0] == "carepack-alerts"


def test_risk_scored_low_returns_none():
    result = route_event(
        "domain.risk.scored",
        {
            "device_id": "d-1",
            "tenant_id": "t-1",
            "risk_level": "low",
            "emit_alert": True,
            "news2": 0,
            "qsofa": 0,
        },
    )
    assert result is None


def test_risk_scored_medium_returns_none():
    result = route_event(
        "domain.risk.scored",
        {
            "device_id": "d-1",
            "tenant_id": "t-1",
            "risk_level": "medium",
            "emit_alert": True,
            "news2": 3,
            "qsofa": 0,
        },
    )
    assert result is None


def test_risk_scored_emit_alert_false_returns_none():
    result = route_event(
        "domain.risk.scored",
        {
            "device_id": "d-1",
            "tenant_id": "t-1",
            "risk_level": "critical",
            "emit_alert": False,
            "news2": 9,
            "qsofa": 3,
        },
    )
    assert result is None


def test_patient_created_missing_id_returns_none():
    result = route_event("domain.patient.created", {"tenantId": "t-1"})
    assert result is None


def test_unknown_topic_returns_none():
    result = route_event("domain.billing.invoice", {"id": "inv-1"})
    assert result is None


# ── BulkIndexer ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bulk_indexer_flushes_on_batch_size():
    mock_client = MagicMock()
    indexer = BulkIndexer(mock_client)

    with patch("main.helpers.async_bulk", new_callable=AsyncMock, return_value=(200, [])) as mock_bulk:
        for i in range(200):
            await indexer.add("carepack-patients", f"p-{i}", {"name": f"Patient {i}"})
        mock_bulk.assert_awaited_once()


@pytest.mark.asyncio
async def test_bulk_indexer_flush_sends_correct_docs():
    mock_client = MagicMock()
    indexer = BulkIndexer(mock_client)
    await indexer.add("carepack-patients", "p-1", {"name": "Jane Doe"})

    with patch("main.helpers.async_bulk", new_callable=AsyncMock, return_value=(1, [])) as mock_bulk:
        await indexer.flush()
        mock_bulk.assert_awaited_once()
        _, batch = mock_bulk.call_args[0]
        assert batch[0]["_id"] == "p-1"
        assert batch[0]["_index"] == "carepack-patients"
        assert batch[0]["name"] == "Jane Doe"


@pytest.mark.asyncio
async def test_bulk_indexer_swallows_opensearch_error():
    mock_client = MagicMock()
    indexer = BulkIndexer(mock_client)
    await indexer.add("carepack-patients", "p-1", {"name": "Jane"})

    with patch("main.helpers.async_bulk", new_callable=AsyncMock, side_effect=Exception("connection refused")):
        await indexer.flush()


@pytest.mark.asyncio
async def test_empty_flush_is_noop():
    mock_client = MagicMock()
    indexer = BulkIndexer(mock_client)

    with patch("main.helpers.async_bulk", new_callable=AsyncMock) as mock_bulk:
        await indexer.flush()
        mock_bulk.assert_not_awaited()


@pytest.mark.asyncio
async def test_buffer_cleared_after_flush():
    mock_client = MagicMock()
    indexer = BulkIndexer(mock_client)
    await indexer.add("carepack-patients", "p-1", {"name": "Jane"})

    with patch("main.helpers.async_bulk", new_callable=AsyncMock, return_value=(1, [])):
        await indexer.flush()
        assert indexer._buffer == []
