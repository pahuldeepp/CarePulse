import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePatientUseCase, CreatePatientDto } from '../patients/create-patient.usecase';

export interface UpdatePatientDto {
  firstName?: string;
  lastName?: string;
  ward?: string;
  status?: string;
  dateOfBirth?: Date;
}

@Injectable()
export class PatientService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly createPatientUseCase: CreatePatientUseCase,
  ) {}

  async findOne(id: string) {
    return this.prisma.patient.findUnique({ where: { id, deletedAt: null } });
  }

  async findAll(tenantId: string) {
    return this.prisma.patient.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async create(dto: CreatePatientDto) {
    return this.createPatientUseCase.execute(dto);
  }

  async update(id: string, tenantId: string, dto: UpdatePatientDto) {
    await this.assertExists(id, tenantId);
    return this.prisma.patient.update({
      where: { id },
      data: {
        ...(dto.firstName && { firstName: dto.firstName }),
        ...(dto.lastName && { lastName: dto.lastName }),
        ...(dto.ward !== undefined && { ward: dto.ward }),
        ...(dto.status && { status: dto.status }),
        ...(dto.dateOfBirth && { dateOfBirth: dto.dateOfBirth }),
      },
    });
  }

  async softDelete(id: string, tenantId: string) {
    await this.assertExists(id, tenantId);
    return this.prisma.patient.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  private async assertExists(id: string, tenantId: string) {
    const patient = await this.prisma.patient.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
    if (!patient) throw new NotFoundException(`Patient ${id} not found`);
  }
}
