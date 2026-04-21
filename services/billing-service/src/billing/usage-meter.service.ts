import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { createLogger, format, transports } from 'winston';

const log = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export interface UsageSummary {
  metric: string;
  total: number;
}

@Injectable()
export class UsageMeterService {
  async record(tenantId: string, metric: string, quantity: number): Promise<void> {
    try {
      const client = await pool.connect();
      try {
        await client.query(`SET LOCAL "app.current_tenant_id" = $1`, [tenantId]);
        await client.query(
          `INSERT INTO billing_usage (tenant_id, metric, quantity) VALUES ($1, $2, $3)`,
          [tenantId, metric, quantity],
        );
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      log.warn({ msg: 'usage_meter_record_failed', tenantId, metric, error: (err as Error).message });
    }
  }

  async summarise(tenantId: string, periodStart: Date, periodEnd: Date): Promise<UsageSummary[]> {
    const client = await pool.connect();
    try {
      await client.query(`SET LOCAL "app.current_tenant_id" = $1`, [tenantId]);
      const rows = await client.query<{ metric: string; total: string }>(
        `SELECT metric, SUM(quantity)::text AS total
           FROM billing_usage
          WHERE tenant_id  = $1
            AND recorded_at >= $2
            AND recorded_at <  $3
          GROUP BY metric`,
        [tenantId, periodStart, periodEnd],
      );
      return rows.rows.map((r) => ({ metric: r.metric, total: Number(r.total) }));
    } finally {
      client.release();
    }
  }
}
