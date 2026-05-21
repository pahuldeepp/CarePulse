import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { Kafka, Producer } from 'kafkajs';
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

const DLQ_TOPIC = process.env.ALERT_PROJECTOR_DLQ_TOPIC ?? 'cdc.outbox.events.dlq';
const AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';
const DYNAMO_MAX_ATTEMPTS = parseInt(process.env.DYNAMO_MAX_ATTEMPTS ?? '3', 10);

@Injectable()
export class AlertProjectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertProjectorService.name);
  private readonly dynamo: DynamoDBClient;
  private readonly alertsTable: string;
  private readonly kafka: Kafka | null;
  private producer: Producer | null = null;

  constructor(private readonly prisma: PrismaService) {
    this.dynamo = new DynamoDBClient({
      region: AWS_REGION,
      maxAttempts: DYNAMO_MAX_ATTEMPTS,
    });
    this.alertsTable = process.env.DYNAMODB_TABLE ?? 'carepulse-alerts';

    const brokers = process.env.KAFKA_BROKERS?.split(',') ?? [];
    this.kafka = brokers.length
      ? new Kafka({ clientId: 'alert-projector', brokers })
      : null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.kafka) {
      this.logger.warn('KAFKA_BROKERS not set — DLQ publishing disabled');
      return;
    }
    this.producer = this.kafka.producer();
    await this.producer.connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.producer) await this.producer.disconnect();
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

    try {
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
    } catch (err) {
      await this.sendToDlq(envelope, err);
      await this.prisma.processedEvent.create({ data: { id: envelope.id } });
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

  private async sendToDlq(envelope: OutboxEnvelope, cause: unknown): Promise<void> {
    const reason = cause instanceof Error ? cause.message : String(cause);
    this.logger.error(`projection_failed event_id=${envelope.id} reason=${reason}`);

    if (!this.producer) {
      this.logger.error(
        `dlq_unavailable event_id=${envelope.id} — KAFKA_BROKERS unset, event will not be reprocessable`,
      );
      return;
    }

    await this.producer.send({
      topic: DLQ_TOPIC,
      messages: [
        {
          key: envelope.id,
          value: JSON.stringify({ envelope, reason, failed_at: new Date().toISOString() }),
        },
      ],
    });
  }
}
