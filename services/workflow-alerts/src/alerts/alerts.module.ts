import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsConsumer } from './alerts.consumer';
import { AlertsService } from './alerts.service';

@Module({
  providers: [AlertsService, PrismaService],
  controllers: [AlertsConsumer],
  exports: [AlertsService],
})
export class AlertsModule {}
