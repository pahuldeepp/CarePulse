import { ConflictException } from '@nestjs/common';
import { CreatePatientUseCase, CreatePatientDto } from './create-patient.usecase';

// ── Prisma mock ───────────────────────────────────────────────────────────────
const mockPatientCreate     = jest.fn();
const mockOutboxEventCreate = jest.fn();
// $executeRaw is called as a tagged template literal — mock it as a function
const mockExecuteRaw        = jest.fn().mockResolvedValue(undefined);

const mockTx = {
  $executeRaw:  mockExecuteRaw,
  patient:      { create: mockPatientCreate },
  outboxEvent:  { create: mockOutboxEventCreate },
};

const mockPrisma = {
  $transaction: jest.fn((fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
};

// ── Test suite ────────────────────────────────────────────────────────────────
describe('CreatePatientUseCase', () => {
  let useCase: CreatePatientUseCase;

  const dto: CreatePatientDto = {
    tenantId:    'tenant-abc',
    mrn:         'MRN-001',
    firstName:   'John',
    lastName:    'Doe',
    dateOfBirth: new Date('1985-06-15'),
    ward:        'ICU',
  };

  const fakePatient = {
    id:          'patient-uuid',
    tenantId:    dto.tenantId,
    mrn:         dto.mrn,
    firstName:   dto.firstName,
    lastName:    dto.lastName,
    dateOfBirth: dto.dateOfBirth,
    ward:        dto.ward,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new CreatePatientUseCase(mockPrisma as any);
    mockPatientCreate.mockResolvedValue(fakePatient);
    mockOutboxEventCreate.mockResolvedValue({});
  });

  it('creates patient and outbox event in the same transaction', async () => {
    const result = await useCase.execute(dto);

    // RLS must be set first via $executeRaw tagged template
    expect(mockExecuteRaw).toHaveBeenCalled();

    // Patient row created
    expect(mockPatientCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mrn: dto.mrn, tenantId: dto.tenantId }),
      }),
    );

    // Outbox event created with correct type
    expect(mockOutboxEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'PatientCreated' }),
      }),
    );

    expect(result).toEqual(fakePatient);
  });

  it('throws ConflictException on duplicate MRN (Prisma P2002)', async () => {
    const prismaUniqueError = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
    });
    mockPatientCreate.mockRejectedValue(prismaUniqueError);

    await expect(useCase.execute(dto)).rejects.toThrow(ConflictException);
  });

  it('re-throws unexpected errors', async () => {
    const unexpectedError = new Error('DB connection lost');
    mockPatientCreate.mockRejectedValue(unexpectedError);

    await expect(useCase.execute(dto)).rejects.toThrow('DB connection lost');
  });
});
