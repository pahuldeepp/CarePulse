import { writeAuditLog, AuditEntry } from './index';

jest.mock('pg', () => {
  const query = jest.fn().mockResolvedValue({});
  const client = { query, release: jest.fn() };
  const connect = jest.fn().mockResolvedValue(client);
  const Pool = jest.fn(() => ({ connect }));
  (Pool as unknown as { _client: typeof client })._client = client;
  return { Pool };
});

jest.mock('winston', () => {
  const error = jest.fn();
  return {
    createLogger: jest.fn(() => ({ error })),
    format: { combine: jest.fn(), timestamp: jest.fn(), json: jest.fn() },
    transports: { Console: jest.fn() },
    _error: error,
  };
});

function getClient(): { query: jest.Mock; release: jest.Mock } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require('pg') as { Pool: { _client: { query: jest.Mock; release: jest.Mock } } };
  return Pool._client;
}

function getLogError(): jest.Mock {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const w = require('winston') as { _error: jest.Mock };
  return w._error;
}

const baseEntry: AuditEntry = {
  tenantId:   't-1',
  userId:     'u-1',
  userRole:   'clinician',
  action:     'CREATE_PATIENT',
  resource:   '/v1/patients',
  resourceId: 'p-123',
  ipAddress:  '127.0.0.1',
  traceId:    'trace-abc',
};

describe('writeAuditLog', () => {
  beforeEach(() => jest.clearAllMocks());

  it('wraps INSERT in a BEGIN / SET LOCAL / COMMIT transaction', async () => {
    await writeAuditLog(baseEntry);
    const { query } = getClient();
    const stmts = query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(stmts[0]).toBe('BEGIN');
    expect(stmts[1]).toMatch(/SET LOCAL/);
    expect(stmts[2]).toMatch(/INSERT INTO audit_log/);
    expect(stmts[3]).toBe('COMMIT');
  });

  it('sets current_tenant_id via SET LOCAL before INSERT', async () => {
    await writeAuditLog(baseEntry);
    const { query } = getClient();
    const setLocalArgs = query.mock.calls[1][1] as unknown[];
    expect(setLocalArgs).toContain('t-1');
  });

  it('inserts all fields into audit_log', async () => {
    await writeAuditLog(baseEntry);
    const { query } = getClient();
    const insertArgs = query.mock.calls[2][1] as unknown[];
    expect(insertArgs).toEqual(
      expect.arrayContaining(['t-1', 'u-1', 'clinician', 'CREATE_PATIENT', '/v1/patients']),
    );
  });

  it('serialises resourceId to JSON in payload column', async () => {
    await writeAuditLog(baseEntry);
    const { query } = getClient();
    const insertArgs = query.mock.calls[2][1] as unknown[];
    expect(insertArgs[5]).toBe(JSON.stringify({ resourceId: 'p-123' }));
  });

  it('passes null for optional fields when omitted', async () => {
    await writeAuditLog({ tenantId: 't-1', userId: 'u-1', action: 'DELETE_PATIENT', resource: '/v1/patients/p-1' });
    const { query } = getClient();
    const insertArgs = query.mock.calls[2][1] as unknown[];
    expect(insertArgs[2]).toBeNull(); // userRole
    expect(insertArgs[5]).toBeNull(); // payload (no resourceId)
    expect(insertArgs[6]).toBeNull(); // ipAddress
    expect(insertArgs[7]).toBeNull(); // traceId
  });

  it('rolls back and logs error when a query inside the transaction fails', async () => {
    getClient().query
      .mockResolvedValueOnce({})                                   // BEGIN
      .mockRejectedValueOnce(new Error('connection refused'));      // SET LOCAL fails

    await expect(writeAuditLog(baseEntry)).resolves.toBeUndefined();

    const stmts = getClient().query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(stmts).toContain('ROLLBACK');
    expect(getLogError()).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'audit_log_write_failed', error: 'connection refused' }),
    );
  });

  it('does not throw when DB rejects with a non-Error value', async () => {
    getClient().query
      .mockResolvedValueOnce({})              // BEGIN
      .mockRejectedValueOnce('string error'); // SET LOCAL fails with string
    await expect(writeAuditLog(baseEntry)).resolves.toBeUndefined();
  });

  it('releases the client after a successful write', async () => {
    await writeAuditLog(baseEntry);
    expect(getClient().release).toHaveBeenCalledTimes(1);
  });

  it('passes traceId correctly into the INSERT parameters', async () => {
    await writeAuditLog({ ...baseEntry, traceId: 'xyz-123' });
    const insertArgs = getClient().query.mock.calls[2][1] as unknown[];
    expect(insertArgs[7]).toBe('xyz-123');
  });
});
