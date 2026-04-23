import { Module }          from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PatientModule }   from './patient/patient.module';
import { AuditInterceptor } from './common/audit.interceptor';

@Module({
  imports:   [PatientModule],
  providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AppModule {}
