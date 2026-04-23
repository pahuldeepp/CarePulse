import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request } from 'express';
import { Pool } from 'pg';
import { createLogger, format, transports } from 'winston';

const log = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const METHOD_ACTION: Record<string, string> = {
  POST:   'CREATE',
  PUT:    'UPDATE',
  PATCH:  'UPDATE',
  DELETE: 'DELETE',
};

/**
 * Persists a single audit row to `audit_log`.
 *
 * Non-fatal by design — a DB failure is logged but never re-thrown so the
 * originating HTTP response is unaffected.
 *
 * @param entry - Fields to record in the audit row.
 */
async function writeAuditLog(entry: {
  tenantId:   string;
  userId:     string;
  userRole?:  string;
  action:     string;
  resource:   string;
  payload?:   unknown;
  ipAddress?: string;
  traceId?:   string;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log
         (tenant_id, user_id, user_role, action, resource, payload, ip_address, trace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        entry.tenantId,
        entry.userId,
        entry.userRole  ?? null,
        entry.action,
        entry.resource,
        entry.payload   ? JSON.stringify(entry.payload) : null,
        entry.ipAddress ?? null,
        entry.traceId   ?? null,
      ],
    );
  } catch (err: unknown) {
    if (err instanceof Error) {
      log.error({
        msg:    'audit_log_write_failed',
        error:  err.message,
        action: entry.action,
        tenant: entry.tenantId,
      });
    }
  }
}

/**
 * NestJS interceptor that automatically records every mutating HTTP request
 * (POST, PUT, PATCH, DELETE) to the `audit_log` table.
 *
 * Registered globally via `APP_INTERCEPTOR` in `AppModule` so all controllers
 * are covered without any per-route wiring. The write fires after the response
 * is returned to the client — it adds zero latency to the request path.
 *
 * Read requests (GET, HEAD, OPTIONS) are passed through without any audit write.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  /**
   * Intercepts the request, delegates to the next handler, then fires a
   * non-blocking audit write via `tap` on the response observable.
   *
   * @param ctx  - NestJS execution context providing access to the HTTP request.
   * @param next - The next handler in the interceptor chain.
   * @returns    Observable of the handler response.
   */
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req    = ctx.switchToHttp().getRequest<Request>();
    const method = req.method.toUpperCase();

    if (!METHOD_ACTION[method]) return next.handle();

    const tenantId   = (req.headers['x-tenant-id'] as string) ?? 'unknown';
    const userId     = (req as unknown as { user?: { id?: string }   }).user?.id   ?? 'anonymous';
    const userRole   = (req as unknown as { user?: { role?: string } }).user?.role;
    const resource   = req.path;
    const ipAddress  = req.ip;
    const traceId    = req.headers['x-trace-id'] as string | undefined;
    const controller = ctx.getClass().name.replace('Controller', '').toUpperCase();
    const action     = `${METHOD_ACTION[method]}_${controller}`;

    return next.handle().pipe(
      tap(() => {
        void writeAuditLog({
          tenantId,
          userId,
          userRole,
          action,
          resource,
          payload:   method !== 'DELETE' ? req.body : undefined,
          ipAddress,
          traceId,
        });
      }),
    );
  }
}
