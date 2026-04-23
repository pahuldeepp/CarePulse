import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';

jest.mock('pg', () => {
  const q = jest.fn().mockResolvedValue({});
  const Pool = jest.fn(() => ({ query: q }));
  (Pool as unknown as { _q: typeof q })._q = q;
  return { Pool };
});

import { AuditInterceptor } from './audit.interceptor';

function getDbQuery(): jest.Mock {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require('pg') as { Pool: { _q: jest.Mock } };
  return Pool._q;
}

function makeCtx(method: string, path = '/v1/patients'): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        path,
        ip: '127.0.0.1',
        body: { mrn: 'MRN001' },
        headers: { 'x-tenant-id': 't-1', 'x-trace-id': 'trace-abc' },
        user: { id: 'u-1', role: 'clinician' },
      }),
    }),
    getClass: () => ({ name: 'PatientController' }),
  } as unknown as ExecutionContext;
}

describe('AuditInterceptor', () => {
  const interceptor = new AuditInterceptor();

  beforeEach(() => jest.clearAllMocks());

  it('writes audit row on POST', (done) => {
    const handler: CallHandler = { handle: () => of({ id: 'p-1' }) };

    interceptor.intercept(makeCtx('POST'), handler).subscribe(() => {
      setTimeout(() => {
        expect(getDbQuery()).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO audit_log'),
          expect.arrayContaining(['t-1', 'u-1', 'clinician', 'CREATE_PATIENT']),
        );
        done();
      }, 20);
    });
  });

  it('writes UPDATE action on PATCH', (done) => {
    const handler: CallHandler = { handle: () => of({}) };

    interceptor.intercept(makeCtx('PATCH'), handler).subscribe(() => {
      setTimeout(() => {
        const call = getDbQuery().mock.calls[0];
        expect(call[1]).toContain('UPDATE_PATIENT');
        done();
      }, 20);
    });
  });

  it('skips audit on GET', (done) => {
    const handler: CallHandler = { handle: () => of([]) };

    interceptor.intercept(makeCtx('GET'), handler).subscribe(() => {
      setTimeout(() => {
        expect(getDbQuery()).not.toHaveBeenCalled();
        done();
      }, 20);
    });
  });

  it('omits payload on DELETE', (done) => {
    const handler: CallHandler = { handle: () => of(null) };

    interceptor.intercept(makeCtx('DELETE', '/v1/patients/p-1'), handler).subscribe(() => {
      setTimeout(() => {
        const call = getDbQuery().mock.calls[0];
        expect(call[1][5]).toBeNull();
        done();
      }, 20);
    });
  });
});
