import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePatientUseCase, CreatePatientDto } from '../patients/create-patient.usecase';

@Injectable()
export class PatientService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly createPatientUseCase: CreatePatientUseCase,
  ) {}

  /**
   * Find a single patient by ID.
   * Reads directly from the write-model (patients table).
   * RLS filters automatically based on tenantId set by the caller's transaction.
   */
  async findOne(id: string) {
    return this.prisma.patient.findUnique({ where: { id } });
  }

  /**
   * Create a patient using the transactional outbox use-case.
   * Writes patient row + outbox event atomically in one Prisma $transaction.
   */
  async create(dto: CreatePatientDto) {
    return this.createPatientUseCase.execute(dto);
  }
}
