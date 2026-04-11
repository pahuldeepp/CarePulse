import { Module } from '@nestjs/common';
import { PatientModule } from './patient/patient.module';

@Module({
  imports: [PatientModule],
})
export class AppModule {}
