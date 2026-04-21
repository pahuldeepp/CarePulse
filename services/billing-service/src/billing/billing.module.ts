import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { UsageMeterService } from './usage-meter.service';

@Module({
  controllers: [BillingController],
  providers: [BillingService, UsageMeterService],
  exports: [UsageMeterService],
})
export class BillingModule {}
