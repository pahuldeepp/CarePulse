import { AlertsService, RiskScoredEvent } from './alerts.service';

type MockTx = {
  alert: { create: jest.Mock; update: jest.Mock };
  outboxEvent: { create: jest.Mock };
};

function makePrismaMock() {
  const tx: MockTx = {
    alert: {
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)),
      update: jest
        .fn()
        .mockImplementation(({ where, data }) =>
          Promise.resolve({ alert_id: where.alert_id, tenant_id: 't-1', ...data }),
        ),
    },
    outboxEvent: { create: jest.fn().mockResolvedValue(undefined) },
  };
  return {
    tx,
    prisma: {
      $transaction: jest.fn(async (cb: (tx: MockTx) => Promise<unknown>) => cb(tx)),
    },
  };
}

describe('AlertsService (S9-08 transactional outbox)', () => {
  let redis: { publish: jest.Mock };

  beforeEach(() => {
    redis = { publish: jest.fn().mockResolvedValue(undefined) };
  });

  it('writes alert + outbox event in the same transaction on risk scored', async () => {
    const { prisma, tx } = makePrismaMock();
    const service = new AlertsService(prisma as never, redis as never);

    const event: RiskScoredEvent = {
      device_id: 'dev-1',
      tenant_id: 't-1',
      news2: 7,
      qsofa: 2,
      risk_level: 'high',
      scored_at: '2026-05-21T10:00:00.000Z',
      emit_alert: true,
    };

    await service.handleRiskScored(event);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.alert.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);

    const outboxArg = tx.outboxEvent.create.mock.calls[0][0].data;
    expect(outboxArg.aggregateType).toBe('Alert');
    expect(outboxArg.eventType).toBe('AlertCreated');
    expect(outboxArg.tenantId).toBe('t-1');
    expect(outboxArg.payload.device_id).toBe('dev-1');

    expect(redis.publish).toHaveBeenCalledWith(
      'alerts:t-1',
      expect.objectContaining({ severity: 'high' }),
    );
  });

  it('skips dedup-suppressed events without touching the DB', async () => {
    const { prisma, tx } = makePrismaMock();
    const service = new AlertsService(prisma as never, redis as never);

    await service.handleRiskScored({
      device_id: 'dev-2',
      tenant_id: 't-1',
      news2: 0,
      qsofa: 0,
      risk_level: 'low',
      scored_at: '2026-05-21T10:00:00.000Z',
      emit_alert: false,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.alert.create).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('writes ack + AlertAcknowledged outbox event in one transaction', async () => {
    const { prisma, tx } = makePrismaMock();
    const service = new AlertsService(prisma as never, redis as never);

    await service.acknowledge('alert-123', 'nurse-9');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.alert.update).toHaveBeenCalledTimes(1);

    const outboxArg = tx.outboxEvent.create.mock.calls[0][0].data;
    expect(outboxArg.eventType).toBe('AlertAcknowledged');
    expect(outboxArg.aggregateId).toBe('alert-123');
    expect(outboxArg.payload.acknowledged_by).toBe('nurse-9');
  });
});
