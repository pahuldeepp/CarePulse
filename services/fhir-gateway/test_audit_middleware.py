"""Tests for fhir-gateway audit middleware."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from audit_middleware import AuditMiddleware, _write_audit
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _make_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(AuditMiddleware)

    @app.get("/fhir/R4/Patient")
    async def get_patients():
        return []

    @app.post("/fhir/R4/Bundle")
    async def store_bundle():
        return {"bundle_id": "b-1"}

    @app.delete("/fhir/R4/Bundle/b-1")
    async def delete_bundle():
        return {}

    return app


@pytest.fixture()
def client():
    return TestClient(_make_app())


# ── Middleware dispatch tests ──────────────────────────────────────────────────


@patch("audit_middleware.asyncio.create_task")
def test_post_triggers_audit_task(mock_task, client):
    client.post(
        "/fhir/R4/Bundle",
        headers={"X-Tenant-ID": "t-1", "X-User-ID": "u-1", "X-Trace-ID": "trace-1"},
    )
    mock_task.assert_called_once()


@patch("audit_middleware.asyncio.create_task")
def test_get_does_not_trigger_audit(mock_task, client):
    client.get("/fhir/R4/Patient", headers={"X-Tenant-ID": "t-1"})
    mock_task.assert_not_called()


@patch("audit_middleware.asyncio.create_task")
def test_delete_triggers_audit_task(mock_task, client):
    client.delete("/fhir/R4/Bundle/b-1", headers={"X-Tenant-ID": "t-1"})
    mock_task.assert_called_once()


# ── _write_audit direct tests — full code path exercised ─────────────────────


@pytest.mark.asyncio
async def test_write_audit_executes_insert():
    mock_conn = AsyncMock()
    mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_conn.__aexit__ = AsyncMock(return_value=False)
    mock_conn.execute = AsyncMock(return_value=None)
    mock_conn.transaction = MagicMock(return_value=mock_conn)

    mock_pool = MagicMock()
    mock_pool.acquire = AsyncMock(return_value=mock_conn)
    mock_pool.release = AsyncMock()

    with patch("audit_middleware._get_pool", new_callable=AsyncMock, return_value=mock_pool):
        await _write_audit("t-1", "u-1", "POST_FHIR_R4_BUNDLE", "/fhir/R4/Bundle", "trace-1")

    assert mock_conn.execute.await_count >= 2
    insert_call = next(
        (c for c in mock_conn.execute.call_args_list if "INSERT INTO audit_log" in str(c)),
        None,
    )
    assert insert_call is not None, "INSERT INTO audit_log was not called"
    insert_args = insert_call[0]
    assert "t-1" in insert_args
    assert "u-1" in insert_args
    assert "trace-1" in insert_args


@pytest.mark.asyncio
async def test_write_audit_swallows_postgres_error():
    import asyncpg

    mock_conn = AsyncMock()
    mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_conn.__aexit__ = AsyncMock(return_value=False)
    mock_conn.execute = AsyncMock(side_effect=asyncpg.PostgresError("connection refused"))
    mock_conn.transaction = MagicMock(return_value=mock_conn)

    mock_pool = MagicMock()
    mock_pool.acquire = AsyncMock(return_value=mock_conn)
    mock_pool.release = AsyncMock()

    with patch("audit_middleware._get_pool", new_callable=AsyncMock, return_value=mock_pool):
        await _write_audit("t-1", "u-1", "POST_BUNDLE", "/fhir/R4/Bundle", None)


@pytest.mark.asyncio
async def test_write_audit_swallows_os_error():
    mock_conn = AsyncMock()
    mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_conn.__aexit__ = AsyncMock(return_value=False)
    mock_conn.execute = AsyncMock(side_effect=OSError("network unreachable"))
    mock_conn.transaction = MagicMock(return_value=mock_conn)

    mock_pool = MagicMock()
    mock_pool.acquire = AsyncMock(return_value=mock_conn)
    mock_pool.release = AsyncMock()

    with patch("audit_middleware._get_pool", new_callable=AsyncMock, return_value=mock_pool):
        await _write_audit("t-1", "u-1", "POST_BUNDLE", "/fhir/R4/Bundle", None)


@pytest.mark.asyncio
async def test_write_audit_handles_none_trace_id():
    mock_conn = AsyncMock()
    mock_conn.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_conn.__aexit__ = AsyncMock(return_value=False)
    mock_conn.execute = AsyncMock(return_value=None)
    mock_conn.transaction = MagicMock(return_value=mock_conn)

    mock_pool = MagicMock()
    mock_pool.acquire = AsyncMock(return_value=mock_conn)
    mock_pool.release = AsyncMock()

    with patch("audit_middleware._get_pool", new_callable=AsyncMock, return_value=mock_pool):
        await _write_audit("t-1", "u-1", "DELETE_BUNDLE", "/fhir/R4/Bundle/b-1", None)

    insert_call = next(
        (c for c in mock_conn.execute.call_args_list if "INSERT INTO audit_log" in str(c)),
        None,
    )
    assert insert_call is not None
    insert_args = insert_call[0]
    assert None in insert_args
