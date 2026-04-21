import { Test } from '@nestjs/testing';
import { UsageMeterService } from './usage-meter.service';

// ── pg mock — factory must not reference outer variables ──────────────────────
jest.mock('pg', () => {
  const q = jest.fn();
  const r = jest.fn();
  const client = { query: q, release: r };
  const c = jest.fn().mockResolvedValue(client);
  const Pool = jest.fn(() => ({ connect: c }));
  (Pool as unknown as { _client: typeof client; _connect: typeof c })._client = client;
  (Pool as unknown as { _client: typeof client; _connect: typeof c })._connect = c;
  return { Pool };
});

function getPgClient(): { query: jest.Mock; release: jest.Mock } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require('pg') as { Pool: { _client: { query: jest.Mock; release: jest.Mock } } };
  return Pool._client;
}

function getPgConnect(): jest.Mock {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require('pg') as { Pool: { _connect: jest.Mock } };
  return Pool._connect;
}

describe('UsageMeterService', () => {
  let service: UsageMeterService;

  beforeEach(async () => {
    jest.clearAllMocks();
    getPgConnect().mockResolvedValue(getPgClient());

    const module = await Test.createTestingModule({
      providers: [UsageMeterService],
    }).compile();
    service = module.get(UsageMeterService);
  });

  it('records usage without throwing even when db fails', async () => {
    getPgConnect().mockRejectedValueOnce(new Error('db down'));
    await expect(service.record('t-1', 'api_call', 10)).resolves.toBeUndefined();
  });

  it('summarises usage by metric', async () => {
    getPgClient().query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ metric: 'api_call', total: '120' }] });

    const result = await service.summarise('t-1', new Date('2026-04-01'), new Date('2026-05-01'));
    expect(result).toEqual([{ metric: 'api_call', total: 120 }]);
  });

  it('returns empty array when no usage recorded', async () => {
    getPgClient().query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [] });

    const result = await service.summarise('t-1', new Date('2026-04-01'), new Date('2026-05-01'));
    expect(result).toEqual([]);
  });
});
