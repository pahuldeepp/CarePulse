import { AlertProjectorService, OutboxEnvelope } from './alert-projector.service';

jest.mock('@aws-sdk/client-dynamodb', () => {
  const send = jest.fn().mockResolvedValue({});
  return {
    DynamoDBClient: jest.fn().mockImplementation(() => ({ send })),
    PutItemCommand: jest.fn().mockImplementation((args) => ({ __cmd: 'put', ...args })),
    __mockSend: send,
  };
});

const { __mockSend: mockSend } = jest.requireMock('@aws-sdk/client-dynamodb');

function makePrismaMock(alreadyProcessed: boolean) {
  return {
    processedEvent: {
      findUnique: jest.fn().mockResolvedValue(alreadyProcessed ? { id: 'evt-1' } : null),
      create: jest.fn().mockResolvedValue(undefined),
    },
  };
}

describe('AlertProjectorService (S9-08)', () => {
  beforeEach(() => {
    mockSend.mockClear();
  });

  it('writes DynamoDB and records processed_event on first AlertCreated', async () => {
    const prisma = makePrismaMock(false);
    const svc = new AlertProjectorService(prisma as never);

    const env: OutboxEnvelope = {
      id: 'evt-1',
      aggregate_type: 'Alert',
      event_type: 'AlertCreated',
      payload: {
        alert_id: 'a-1',
        tenant_id: 't-1',
        device_id: 'd-1',
        severity: 'critical',
        news2: 9,
        qsofa: 3,
        triggered_at: '2026-05-21T10:00:00.000Z',
      },
    };

    await svc.project(env);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(prisma.processedEvent.create).toHaveBeenCalledWith({ data: { id: 'evt-1' } });
  });

  it('is idempotent — second delivery of the same event_id is a no-op', async () => {
    const prisma = makePrismaMock(true);
    const svc = new AlertProjectorService(prisma as never);

    await svc.project({
      id: 'evt-1',
      aggregate_type: 'Alert',
      event_type: 'AlertCreated',
      payload: {
        alert_id: 'a-1',
        tenant_id: 't-1',
        device_id: 'd-1',
        severity: 'high',
        news2: 5,
        qsofa: 1,
        triggered_at: '2026-05-21T10:00:00.000Z',
      },
    });

    expect(mockSend).not.toHaveBeenCalled();
    expect(prisma.processedEvent.create).not.toHaveBeenCalled();
  });

  it('skips non-Alert aggregate types', async () => {
    const prisma = makePrismaMock(false);
    const svc = new AlertProjectorService(prisma as never);

    await svc.project({
      id: 'evt-2',
      aggregate_type: 'Patient',
      event_type: 'PatientCreated',
      payload: {} as never,
    });

    expect(prisma.processedEvent.findUnique).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
