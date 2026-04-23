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
    mock_pool = MagicMock()
    mock_pool.execute = AsyncMock(return_value=None)

    with patch("audit_middleware._get_pool", new_callable=AsyncMock, return_value=mock_pool):
        await _write_audit("t-1", "u-1", "POST_FHIR_R4_BUNDLE", "/fhir/R4/Bundle", "trace-1")

    mock_pool.execute.assert_awaited_once()
    sql, *args = mock_pool.execute.call_args[0]
    assert "INSERT INTO audit_log" in sql
    assert "t-1" in args
    assert "u-1" in args
    assert "trace-1" in args


@pytest.mark.asyncio
async def test_write_audit_swallows_postgres_error():
    import asyncpg

    mock_pool = MagicMock()
    mock_pool.execute = AsyncMock(side_effect=asyncpg.PostgresError("connection refused"))

    with patch("audit_middleware._get_pool", new_callable=AsyncMock, return_value=mock_pool):
        await _write_audit("t-1", "u-1", "POST_BUNDLE", "/fhir/R4/Bundle", None)


@pytest.mark.asyncio
async def test_write_audit_swallows_os_error():
    mock_pool = MagicMock()
    mock_pool.execute = AsyncMock(side_effect=OSError("network unreachable"))

    with patch("audit_middleware._get_pool", new_callable=AsyncMock, return_value=mock_pool):
        await _write_audit("t-1", "u-1", "POST_BUNDLE", "/fhir/R4/Bundle", None)


@pytest.mark.asyncio
async def test_write_audit_handles_none_trace_id():
    mock_pool = MagicMock()
    mock_pool.execute = AsyncMock(return_value=None)

    with patch("audit_middleware._get_pool", new_callable=AsyncMock, return_value=mock_pool):
        await _write_audit("t-1", "u-1", "DELETE_BUNDLE", "/fhir/R4/Bundle/b-1", None)

    _, *args = mock_pool.execute.call_args[0]
    assert None in args
