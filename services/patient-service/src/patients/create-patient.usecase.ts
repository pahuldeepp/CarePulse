import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { randomUUID } from 'node:crypto';

export interface CreatePatientDto {
  tenantId: string;
  mrn: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  ward?: string;
}

@Injectable()
export class CreatePatientUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(dto: CreatePatientDto) {
    const patientId = randomUUID();
    const eventId   = randomUUID();

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1️⃣  Set RLS tenant so Postgres policies fire
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_tenant_id = '${dto.tenantId}'`,
        );

        // 2️⃣  Insert patient
        const patient = await tx.patient.create({
          data: {
            id:          patientId,
            tenantId:    dto.tenantId,
            mrn:         dto.mrn,
            firstName:   dto.firstName,
            lastName:    dto.lastName,
            dateOfBirth: dto.dateOfBirth,
            ward:        dto.ward,
          },
        });

        // 3️⃣  Write outbox event atomically — same transaction
        //     If Kafka is down, the patient row still commits safely.
        //     The relay worker polls outbox_events WHERE processed_at IS NULL.
        await tx.outboxEvent.create({
          data: {
            id:          eventId,
            tenantId:    dto.tenantId,
            aggregateId: patientId,
            eventType:   'PatientCreated',
            payload: {
              patientId:   patient.id,
              tenantId:    dto.tenantId,
              mrn:         patient.mrn,
              firstName:   patient.firstName,
              lastName:    patient.lastName,
              dateOfBirth: patient.dateOfBirth.toISOString(),
              ward:        patient.ward ?? null,
            },
          },
        });

        return patient;
      });
    } catch (err: any) {
      // Postgres unique violation code = 23505
      if (err?.code === 'P2002') {
        throw new ConflictException(
          `Patient with MRN "${dto.mrn}" already exists in this tenant`,
        );
      }
      throw err;
    }
  }
}
