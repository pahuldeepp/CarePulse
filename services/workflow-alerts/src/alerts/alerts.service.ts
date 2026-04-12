import { Injectable, Logger } from '@nestjs/common';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { PrismaService } from '../prisma/prisma.service';

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
  private readonly dynamo = new DynamoDBClient({});
  private readonly alertsTable = process.env.DYNAMODB_TABLE ?? 'carepulse-alerts';

  constructor(private readonly prisma: PrismaService) {}

  async handleRiskScored(event: RiskScoredEvent): Promise<void> {
    // risk-engine sets emit_alert=false for duplicate readings within DEDUP_TTL.
    // This prevents 720 Postgres inserts/hour per device in sustained critical state.
    if (!event.emit_alert) {
      return;
    }

    // Postgres — source of truth for alert history, audit trail, and reporting.
    const alert = await this.prisma.alert.create({
      data: {
        tenant_id: event.tenant_id,
        device_id: event.device_id,
        severity: event.risk_level,
        news2: event.news2,
        qsofa: event.qsofa,
        triggered_at: new Date(event.scored_at),
      },
    });

    // DynamoDB INSERT triggers stream_handler Lambda via DynamoDB Streams.
    // This is the entry point into the 15-min NHS NEWS2 escalation flow.
    await this.writeToDynamo(alert.alert_id, event);

    this.logger.log(
      `alert_created alert_id=${alert.alert_id} severity=${event.risk_level} device_id=${event.device_id}`,
    );
  }

  async acknowledge(alertId: string, nurseId: string): Promise<void> {
    const now = new Date();

    // Postgres — persist acknowledgement for audit trail.
    await this.prisma.alert.update({
      where: { alert_id: alertId },
      data: { acknowledged_at: now, acknowledged_by: nurseId },
    });

    // DynamoDB — check_handler Lambda reads acknowledged_at to decide whether
    // to escalate. Writing it here ensures Lambda sees the ack before the 15-min window.
    await this.dynamo.send(
      new PutItemCommand({
        TableName: this.alertsTable,
        Item: {
          alert_id:        { S: alertId },
          acknowledged_at: { S: now.toISOString() },
          acknowledged_by: { S: nurseId },
        },
      }),
    );

    this.logger.log(`alert_acknowledged alert_id=${alertId} nurse_id=${nurseId}`);
  }

  private async writeToDynamo(alertId: string, event: RiskScoredEvent): Promise<void> {
    try {
      await this.dynamo.send(
        new PutItemCommand({
          TableName: this.alertsTable,
          Item: {
            alert_id:   { S: alertId },
            tenant_id:  { S: event.tenant_id },
            severity:   { S: event.risk_level },
            device_id:  { S: event.device_id },
            created_at: { S: event.scored_at },
          },
        }),
      );
    } catch (err) {
      // DynamoDB unavailability must never fail the Postgres write.
      // check_handler will not fire if DynamoDB is down, but Postgres has the record.
      this.logger.error(`dynamo_write_failed alert_id=${alertId} error=${err}`);
    }
  }
}
