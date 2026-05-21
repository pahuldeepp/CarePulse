import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AlertProjectorConsumer } from './alert-projector.consumer';
import { AlertProjectorService } from './alert-projector.service';

@Module({
  providers: [AlertProjectorService, PrismaService],
  controllers: [AlertProjectorConsumer],
  exports: [AlertProjectorService],
})
export class AlertProjectorModule {}
