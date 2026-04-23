import { Pool } from 'pg';
import { createLogger, format, transports } from 'winston';

const log = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export interface AuditEntry {
  tenantId:   string;
  userId:     string;
  userRole?:  string;
  action:     string;
  resource:   string;
  payload?:   unknown;
  ipAddress?: string;
  traceId?:   string;
}

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
    // Non-fatal — audit failure must never break the clinical workflow
    log.error({
      msg:    'audit_log_write_failed',
      error:  (err as Error).message,
      action: entry.action,
      tenant: entry.tenantId,
    });
  }
}
