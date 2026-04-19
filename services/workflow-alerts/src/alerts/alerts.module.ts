import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { AlertsConsumer } from './alerts.consumer';
import { AlertsService } from './alerts.service';

@Module({
  providers: [AlertsService, PrismaService, RedisService],
  controllers: [AlertsConsumer],
  exports: [AlertsService],
})
export class AlertsModule {}
