import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { AlertProjectorService, OutboxEnvelope } from './alert-projector.service';

@Controller()
export class AlertProjectorConsumer {
  constructor(private readonly projector: AlertProjectorService) {}

  @MessagePattern('cdc.outbox.events')
  async onOutboxEvent(@Payload() envelope: OutboxEnvelope): Promise<void> {
    await this.projector.project(envelope);
  }
}
