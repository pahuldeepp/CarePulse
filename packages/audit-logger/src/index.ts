import { Pool, PoolClient } from 'pg';
import { createLogger, format, transports } from 'winston';

const log = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for audit logging');
}

const pool = new Pool({ connectionString: DATABASE_URL });

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
  /** Minimal resource metadata — never the full request body to avoid storing PHI. */
  resourceId?: string;
  /** Client IP address. */
  ipAddress?: string;
  /** Distributed trace ID for correlating logs across services. */
  traceId?: string;
}

/**
 * Persists an audit entry to the `audit_log` Postgres table.
 *
 * Sets `app.current_tenant_id` within a transaction so the RLS policy on
 * `audit_log` is satisfied even when the app role owns the table.
 *
 * Non-fatal by design: a DB failure is logged with structured context but
 * never re-thrown so the originating clinical request still succeeds.
 *
 * @param entry - The audit event to record.
 */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(`SET LOCAL "app.current_tenant_id" = $1`, [entry.tenantId]);
    await client.query(
      `INSERT INTO audit_log
         (tenant_id, user_id, user_role, action, resource, payload, ip_address, trace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        entry.tenantId,
        entry.userId,
        entry.userRole  ?? null,
        entry.action,
        entry.resource,
        entry.resourceId ? JSON.stringify({ resourceId: entry.resourceId }) : null,
        entry.ipAddress ?? null,
        entry.traceId   ?? null,
      ],
    );
    await client.query('COMMIT');
  } catch (err: unknown) {
    if (client) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    log.error({
      msg:    'audit_log_write_failed',
      error:  err instanceof Error ? err.message : String(err),
      action: entry.action,
      tenant: entry.tenantId,
    });
  } finally {
    client?.release();
  }
}
