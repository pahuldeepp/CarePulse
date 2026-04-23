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
    """Return the shared asyncpg connection pool, creating it on first call.

    Uses a module-level singleton so connections are reused across requests.
    min_size=1 keeps one connection warm; max_size=5 limits pressure on Postgres.
    """
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
    return _pool


MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


class AuditMiddleware(BaseHTTPMiddleware):
    """Starlette middleware that records every mutating FHIR request to audit_log.

    Attaches after the response is built so the client receives its reply before
    the audit write starts. Uses ``asyncio.create_task`` for fire-and-forget
    semantics — a slow or failed DB write never delays the HTTP response.

    Headers read:
        X-Tenant-ID  — identifies the tenant (required for RLS).
        X-User-ID    — identifies the acting user.
        X-Trace-ID   — distributed trace ID for cross-service correlation.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        """Process the request and schedule an async audit write for mutations.

        Args:
            request:   The incoming Starlette request.
            call_next: The next middleware or route handler in the chain.

        Returns:
            The response from the downstream handler, unmodified.
        """
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
    """Insert one row into ``audit_log`` using the shared asyncpg pool.

    Non-fatal: ``asyncpg.PostgresError``, ``asyncpg.InterfaceError``, and
    ``OSError`` are caught and logged. Any other unexpected exception is allowed
    to propagate so it surfaces in the task exception handler rather than being
    silently swallowed.

    Args:
        tenant_id: Tenant that owns the resource.
        user_id:   Authenticated user performing the action.
        action:    Derived action string (e.g. POST_FHIR_R4_BUNDLE).
        resource:  Request path (e.g. /fhir/R4/Bundle).
        trace_id:  Optional distributed trace ID.
    """
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
    except (asyncpg.PostgresError, OSError) as exc:
        log.error("audit_log_write_failed", error=str(exc), action=action, tenant=tenant_id)
    except asyncpg.InterfaceError as exc:
        log.error("audit_log_pool_error", error=str(exc), action=action, tenant=tenant_id)
