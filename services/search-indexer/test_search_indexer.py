"""Tests for search-indexer: BulkIndexer, event handlers, search endpoint."""

from unittest.mock import AsyncMock, patch

import pytest

# ── BulkIndexer ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bulk_indexer_buffers_index_action():
    from main import BulkIndexer

    mock_client = AsyncMock()
    indexer = BulkIndexer(mock_client)

    await indexer.add_index("p-1", {"full_name": "Jane Doe", "tenant_id": "t-1"})
    assert len(indexer._buffer) == 1
    assert indexer._buffer[0]["_id"] == "p-1"
    assert indexer._buffer[0]["_op_type"] == "index"


@pytest.mark.asyncio
async def test_bulk_indexer_buffers_update_action():
    from main import BulkIndexer

    mock_client = AsyncMock()
    indexer = BulkIndexer(mock_client)

    await indexer.add_update("p-1", {"news2": 7, "risk_level": "critical"})
    assert indexer._buffer[0]["_op_type"] == "update"
    assert indexer._buffer[0]["doc"]["news2"] == 7


@pytest.mark.asyncio
async def test_bulk_indexer_flush_calls_opensearch():
    from main import BulkIndexer

    mock_client = AsyncMock()

    with patch("main.async_bulk", new_callable=AsyncMock) as mock_bulk:
        mock_bulk.return_value = (1, [])
        indexer = BulkIndexer(mock_client)
        await indexer.add_index("p-1", {"full_name": "Jane", "tenant_id": "t-1"})
        await indexer._flush()
        mock_bulk.assert_awaited_once()
        assert indexer._buffer == []


@pytest.mark.asyncio
async def test_bulk_indexer_flush_empty_noop():
    from main import BulkIndexer

    mock_client = AsyncMock()
    with patch("main.async_bulk", new_callable=AsyncMock) as mock_bulk:
        indexer = BulkIndexer(mock_client)
        await indexer._flush()
        mock_bulk.assert_not_awaited()


# ── Event handlers ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_handle_patient_created_indexes_doc():
    from main import BulkIndexer, handle_patient_created

    mock_client = AsyncMock()
    indexer = BulkIndexer(mock_client)

    payload = {
        "patientId": "p-1",
        "tenantId": "t-1",
        "mrn": "MRN001",
        "firstName": "Jane",
        "lastName": "Doe",
        "ward": "ICU",
    }
    await handle_patient_created(indexer, payload)
    assert len(indexer._buffer) == 1
    assert indexer._buffer[0]["full_name"] == "Jane Doe"
    assert indexer._buffer[0]["mrn"] == "MRN001"


@pytest.mark.asyncio
async def test_handle_patient_created_missing_id_skips():
    from main import BulkIndexer, handle_patient_created

    mock_client = AsyncMock()
    indexer = BulkIndexer(mock_client)
    await handle_patient_created(indexer, {"tenantId": "t-1"})
    assert indexer._buffer == []


@pytest.mark.asyncio
async def test_handle_risk_scored_updates_doc():
    from main import BulkIndexer, handle_risk_scored

    mock_client = AsyncMock()
    indexer = BulkIndexer(mock_client)

    payload = {
        "patient_id": "p-1",
        "tenant_id": "t-1",
        "news2": 7.0,
        "risk_level": "critical",
        "scored_at": "2026-04-21T10:00:00Z",
    }
    await handle_risk_scored(indexer, payload)
    assert indexer._buffer[0]["_op_type"] == "update"
    assert indexer._buffer[0]["doc"]["news2"] == 7
    assert indexer._buffer[0]["doc"]["risk_level"] == "critical"


@pytest.mark.asyncio
async def test_handle_risk_scored_missing_patient_id_skips():
    from main import BulkIndexer, handle_risk_scored

    mock_client = AsyncMock()
    indexer = BulkIndexer(mock_client)
    await handle_risk_scored(indexer, {"news2": 5, "risk_level": "high"})
    assert indexer._buffer == []


# ── Search endpoint ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_search_endpoint_returns_hits():
    import main as m
    from aiohttp.test_utils import TestClient, TestServer

    mock_os = AsyncMock()
    mock_os.search = AsyncMock(
        return_value={
            "hits": {
                "total": {"value": 1},
                "hits": [
                    {
                        "_id": "p-1",
                        "_source": {
                            "full_name": "Jane Doe",
                            "mrn": "MRN001",
                            "ward": "ICU",
                            "status": "active",
                            "news2": 7,
                            "risk_level": "critical",
                            "updated_at": "2026-04-21T10:00:00Z",
                        },
                    }
                ],
            }
        }
    )
    m._os_client = mock_os

    http_app = await m.build_http_app()
    async with TestClient(TestServer(http_app)) as client:
        resp = await client.post(
            "/search",
            json={"query": "Jane", "tenantId": "t-1", "size": 10},
        )
        assert resp.status == 200
        body = await resp.json()
        assert body["total"] == 1
        assert body["hits"][0]["id"] == "p-1"


@pytest.mark.asyncio
async def test_search_endpoint_missing_tenant_returns_400():
    import main as m
    from aiohttp.test_utils import TestClient, TestServer

    http_app = await m.build_http_app()
    async with TestClient(TestServer(http_app)) as client:
        resp = await client.post("/search", json={"query": "Jane"})
        assert resp.status == 400


@pytest.mark.asyncio
async def test_healthz_returns_ok():
    import main as m
    from aiohttp.test_utils import TestClient, TestServer

    http_app = await m.build_http_app()
    async with TestClient(TestServer(http_app)) as client:
        resp = await client.get("/healthz")
        assert resp.status == 200
