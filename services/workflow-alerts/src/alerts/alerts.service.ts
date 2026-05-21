import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export interface RiskScoredEvent {
  device_id: string;
  tenant_id: string;
  news2: number;
  qsofa: number;
  risk_level: string;
  scored_at: string;
  emit_alert: boolean;
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async handleRiskScored(event: RiskScoredEvent): Promise<void> {
    if (!event.emit_alert) {
      return;
    }

    const alertId = randomUUID();
    const eventId = randomUUID();

    const alert = await this.prisma.$transaction(async (tx) => {
      const row = await tx.alert.create({
        data: {
          alert_id: alertId,
          tenant_id: event.tenant_id,
          device_id: event.device_id,
          severity: event.risk_level,
          news2: event.news2,
          qsofa: event.qsofa,
          triggered_at: new Date(event.scored_at),
        },
      });

      await tx.outboxEvent.create({
        data: {
          id: eventId,
          tenantId: event.tenant_id,
          aggregateId: alertId,
          aggregateType: 'Alert',
          eventType: 'AlertCreated',
          payload: {
            alert_id: alertId,
            tenant_id: event.tenant_id,
            device_id: event.device_id,
            severity: event.risk_level,
            news2: event.news2,
            qsofa: event.qsofa,
            triggered_at: event.scored_at,
          },
        },
      });

      return row;
    });

    await this.redis.publish(`alerts:${event.tenant_id}`, {
      id: alert.alert_id,
      severity: event.risk_level,
      status: 'open',
      news2: event.news2,
      qsofa: event.qsofa,
      triggeredAt: event.scored_at,
    });

    this.logger.log(
      `alert_created alert_id=${alert.alert_id} severity=${event.risk_level} device_id=${event.device_id}`,
    );
  }

  async acknowledge(alertId: string, nurseId: string): Promise<void> {
    const now = new Date();
    const eventId = randomUUID();

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.alert.update({
        where: { alert_id: alertId },
        data: { acknowledged_at: now, acknowledged_by: nurseId },
      });

      await tx.outboxEvent.create({
        data: {
          id: eventId,
          tenantId: row.tenant_id,
          aggregateId: alertId,
          aggregateType: 'Alert',
          eventType: 'AlertAcknowledged',
          payload: {
            alert_id: alertId,
            tenant_id: row.tenant_id,
            acknowledged_at: now.toISOString(),
            acknowledged_by: nurseId,
          },
        },
      });

      return row;
    });

    this.logger.log(
      `alert_acknowledged alert_id=${alertId} nurse_id=${nurseId} tenant_id=${updated.tenant_id}`,
    );
  }
}
