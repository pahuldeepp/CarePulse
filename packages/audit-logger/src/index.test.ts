import { writeAuditLog, AuditEntry } from './index';

jest.mock('pg', () => {
  const q = jest.fn().mockResolvedValue({});
  const Pool = jest.fn(() => ({ query: q }));
  (Pool as unknown as { _q: typeof q })._q = q;
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

function getDbQuery(): jest.Mock {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require('pg') as { Pool: { _q: jest.Mock } };
  return Pool._q;
}

function getLogError(): jest.Mock {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const w = require('winston') as { _error: jest.Mock };
  return w._error;
}

const baseEntry: AuditEntry = {
  tenantId:  't-1',
  userId:    'u-1',
  userRole:  'clinician',
  action:    'CREATE_PATIENT',
  resource:  '/v1/patients',
  payload:   { mrn: 'MRN001' },
  ipAddress: '127.0.0.1',
  traceId:   'trace-abc',
};

describe('writeAuditLog', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts all fields into audit_log', async () => {
    await writeAuditLog(baseEntry);

    expect(getDbQuery()).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_log'),
      expect.arrayContaining(['t-1', 'u-1', 'clinician', 'CREATE_PATIENT', '/v1/patients']),
    );
  });

  it('serialises payload to JSON string', async () => {
    await writeAuditLog(baseEntry);
    const args = getDbQuery().mock.calls[0][1] as unknown[];
    expect(args[5]).toBe(JSON.stringify({ mrn: 'MRN001' }));
  });

  it('passes null for optional fields when omitted', async () => {
    await writeAuditLog({ tenantId: 't-1', userId: 'u-1', action: 'DELETE_PATIENT', resource: '/v1/patients/p-1' });
    const args = getDbQuery().mock.calls[0][1] as unknown[];
    expect(args[2]).toBeNull(); // userRole
    expect(args[5]).toBeNull(); // payload
    expect(args[6]).toBeNull(); // ipAddress
    expect(args[7]).toBeNull(); // traceId
  });

  it('logs error and does not throw when DB query fails', async () => {
    getDbQuery().mockRejectedValueOnce(new Error('connection refused'));

    await expect(writeAuditLog(baseEntry)).resolves.toBeUndefined();
    expect(getLogError()).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'audit_log_write_failed', error: 'connection refused' }),
    );
  });

  it('does not throw when DB rejects with a non-Error value', async () => {
    getDbQuery().mockRejectedValueOnce('string error');
    await expect(writeAuditLog(baseEntry)).resolves.toBeUndefined();
  });

  it('passes traceId correctly', async () => {
    await writeAuditLog({ ...baseEntry, traceId: 'xyz-123' });
    const args = getDbQuery().mock.calls[0][1] as unknown[];
    expect(args[7]).toBe('xyz-123');
  });
});
