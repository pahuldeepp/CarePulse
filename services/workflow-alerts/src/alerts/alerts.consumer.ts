import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { AlertsService, RiskScoredEvent } from './alerts.service';

@Controller()
export class AlertsConsumer {
  private readonly logger = new Logger(AlertsConsumer.name);

  constructor(private readonly alertsService: AlertsService) {}

  /**
   * Kafka topic: domain.risk.scored
   * Published by risk-engine after every telemetry reading is scored.
   * emit_alert=false means Redis dedup suppressed it — skip silently.
   */
  @MessagePattern('domain.risk.scored')
  async onRiskScored(@Payload() event: RiskScoredEvent): Promise<void> {
    this.logger.debug(
      `risk_scored_received device_id=${event.device_id} level=${event.risk_level} emit=${event.emit_alert}`,
    );
    await this.alertsService.handleRiskScored(event);
  }
}
