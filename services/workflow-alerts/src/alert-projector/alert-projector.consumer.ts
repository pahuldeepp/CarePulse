import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { AlertProjectorService, OutboxEnvelope } from './alert-projector.service';

@Controller()
export class AlertProjectorConsumer {
  private readonly logger = new Logger(AlertProjectorConsumer.name);

  constructor(private readonly projector: AlertProjectorService) {}

  @MessagePattern('cdc.outbox.events')
  async onOutboxEvent(@Payload() envelope: OutboxEnvelope): Promise<void> {
    try {
      await this.projector.project(envelope);
    } catch (err) {
      this.logger.error(
        `projection_failed event_id=${envelope?.id} type=${envelope?.event_type} error=${err}`,
      );
      throw err;
    }
  }
}
