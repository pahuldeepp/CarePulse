import { Module } from '@nestjs/common';
import { AlertsModule } from './alerts/alerts.module';
import { AlertProjectorModule } from './alert-projector/alert-projector.module';

@Module({
  imports: [AlertsModule, AlertProjectorModule],
})
export class AppModule {}
