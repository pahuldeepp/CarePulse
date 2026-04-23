"""
Audit middleware for fhir-gateway.

Fires a non-blocking DB write for every mutating FHIR call (POST/PUT/PATCH/DELETE).
Failures are logged but never propagate — audit must not break the clinical workflow.
"""

import asyncio
import os

import asyncpg
import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

log = structlog.get_logger()

DATABASE_URL = os.getenv("DATABASE_URL", "")

_pool: asyncpg.Pool | None = None


async def _get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
    return _pool


MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


class AuditMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)

        if request.method.upper() not in MUTATING_METHODS:
            return response

        tenant_id = request.headers.get("X-Tenant-ID", "unknown")
        user_id = request.headers.get("X-User-ID", "anonymous")
        trace_id = request.headers.get("X-Trace-ID")
        action = f"{request.method.upper()}_{request.url.path.strip('/').replace('/', '_').upper()}"
        resource = str(request.url.path)

        asyncio.create_task(_write_audit(tenant_id, user_id, action, resource, trace_id))

        return response


async def _write_audit(
    tenant_id: str,
    user_id: str,
    action: str,
    resource: str,
    trace_id: str | None,
) -> None:
    try:
        pool = await _get_pool()
        await pool.execute(
            """INSERT INTO audit_log
                 (tenant_id, user_id, action, resource, trace_id)
               VALUES ($1, $2, $3, $4, $5)""",
            tenant_id,
            user_id,
            action,
            resource,
            trace_id,
        )
    except Exception as exc:
        log.error("audit_log_write_failed", error=str(exc), action=action, tenant=tenant_id)
