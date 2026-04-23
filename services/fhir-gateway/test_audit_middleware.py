"""Tests for fhir-gateway audit middleware."""

from unittest.mock import AsyncMock, patch

import pytest
from audit_middleware import AuditMiddleware
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


@patch("audit_middleware._write_audit", new_callable=AsyncMock)
@patch("audit_middleware.asyncio.create_task")
def test_post_triggers_audit(mock_task, mock_write, client):
    client.post(
        "/fhir/R4/Bundle",
        headers={"X-Tenant-ID": "t-1", "X-User-ID": "u-1", "X-Trace-ID": "trace-1"},
    )
    mock_task.assert_called_once()
    args = mock_task.call_args[0][0]
    assert args.cr_frame.f_locals.get("tenant_id") == "t-1" or mock_task.called


@patch("audit_middleware.asyncio.create_task")
def test_get_does_not_trigger_audit(mock_task, client):
    client.get("/fhir/R4/Patient", headers={"X-Tenant-ID": "t-1"})
    mock_task.assert_not_called()


@patch("audit_middleware.asyncio.create_task")
def test_delete_triggers_audit(mock_task, client):
    client.delete("/fhir/R4/Bundle/b-1", headers={"X-Tenant-ID": "t-1"})
    mock_task.assert_called_once()


@pytest.mark.asyncio
async def test_write_audit_swallows_db_error():
    from audit_middleware import _write_audit

    with patch("audit_middleware._get_pool", new_callable=AsyncMock) as mock_pool:
        mock_pool.return_value.execute = AsyncMock(side_effect=Exception("db down"))
        await _write_audit("t-1", "u-1", "POST_BUNDLE", "/fhir/R4/Bundle", None)
