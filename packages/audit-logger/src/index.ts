import { Pool } from 'pg';
import { createLogger, format, transports } from 'winston';

const log = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Represents a single audit event capturing who did what, to which resource,
 * and under which tenant context.
 *
 * All fields map 1-to-1 to columns in the `audit_log` table.
 */
export interface AuditEntry {
  /** Tenant that owns the resource being mutated. */
  tenantId: string;
  /** Authenticated user performing the action. */
  userId: string;
  /** Role of the user (e.g. clinician, admin). Optional. */
  userRole?: string;
  /** Verb + resource type (e.g. CREATE_PATIENT, DELETE_ALERT). */
  action: string;
  /** HTTP path or resource identifier (e.g. /v1/patients/p-123). */
  resource: string;
  /** Request body for mutating operations. Omitted on DELETE. */
  payload?: unknown;
  /** Client IP address. */
  ipAddress?: string;
  /** Distributed trace ID for correlating logs across services. */
  traceId?: string;
}

/**
 * Persists an audit entry to the `audit_log` Postgres table.
 *
 * This function is intentionally non-fatal: a DB failure is logged with
 * structured context but never re-thrown. Audit writes must never interrupt
 * the clinical workflow — if the audit table is unavailable, the originating
 * request still succeeds.
 *
 * @param entry - The audit event to record.
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
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
