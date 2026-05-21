import { Injectable, Logger } from '@nestjs/common';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { PrismaService } from '../prisma/prisma.service';

export interface AlertCreatedPayload {
  alert_id: string;
  tenant_id: string;
  device_id: string;
  severity: string;
  news2: number;
  qsofa: number;
  triggered_at: string;
}

export interface AlertAcknowledgedPayload {
  alert_id: string;
  tenant_id: string;
  acknowledged_at: string;
  acknowledged_by: string;
}

export interface OutboxEnvelope {
  id: string;
  aggregate_type?: string;
  event_type: string;
  payload: AlertCreatedPayload | AlertAcknowledgedPayload;
}

@Injectable()
export class AlertProjectorService {
  private readonly logger = new Logger(AlertProjectorService.name);
  private readonly dynamo: DynamoDBClient;
  private readonly alertsTable: string;

  constructor(private readonly prisma: PrismaService) {
    this.dynamo = new DynamoDBClient({});
    this.alertsTable = process.env.DYNAMODB_TABLE ?? 'carepulse-alerts';
  }

  async project(envelope: OutboxEnvelope): Promise<void> {
    if (envelope.aggregate_type && envelope.aggregate_type !== 'Alert') {
      return;
    }

    const alreadyProcessed = await this.prisma.processedEvent.findUnique({
      where: { id: envelope.id },
    });
    if (alreadyProcessed) {
      this.logger.debug(`skip_duplicate event_id=${envelope.id}`);
      return;
    }

    switch (envelope.event_type) {
      case 'AlertCreated':
        await this.writeCreated(envelope.payload as AlertCreatedPayload);
        break;
      case 'AlertAcknowledged':
        await this.writeAcknowledged(envelope.payload as AlertAcknowledgedPayload);
        break;
      default:
        this.logger.debug(`skip_unknown_event_type type=${envelope.event_type}`);
        return;
    }

    await this.prisma.processedEvent.create({ data: { id: envelope.id } });
    this.logger.log(`projected event_id=${envelope.id} type=${envelope.event_type}`);
  }

  private async writeCreated(p: AlertCreatedPayload): Promise<void> {
    await this.dynamo.send(
      new PutItemCommand({
        TableName: this.alertsTable,
        Item: {
          alert_id:   { S: p.alert_id },
          tenant_id:  { S: p.tenant_id },
          severity:   { S: p.severity },
          device_id:  { S: p.device_id },
          created_at: { S: p.triggered_at },
        },
      }),
    );
  }

  private async writeAcknowledged(p: AlertAcknowledgedPayload): Promise<void> {
    await this.dynamo.send(
      new PutItemCommand({
        TableName: this.alertsTable,
        Item: {
          alert_id:        { S: p.alert_id },
          acknowledged_at: { S: p.acknowledged_at },
          acknowledged_by: { S: p.acknowledged_by },
        },
      }),
    );
  }
}
