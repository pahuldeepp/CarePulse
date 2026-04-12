import { Module } from '@nestjs/common';
import { PatientController } from './patient.controller';
import { PatientService } from './patient.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePatientUseCase } from '../patients/create-patient.usecase';

@Module({
  controllers: [PatientController],
  providers: [
    PatientService,       // orchestrates calls to use-cases + Prisma
    PrismaService,        // singleton DB client — shared across all providers
    CreatePatientUseCase, // transactional outbox use-case
  ],
})
export class PatientModule {}
