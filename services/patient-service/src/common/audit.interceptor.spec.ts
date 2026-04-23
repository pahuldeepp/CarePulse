import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';

jest.mock('pg', () => {
  const query = jest.fn().mockResolvedValue({});
  const client = { query, release: jest.fn() };
  const connect = jest.fn().mockResolvedValue(client);
  const Pool = jest.fn(() => ({ connect }));
  (Pool as unknown as { _client: typeof client })._client = client;
  return { Pool };
});

import { AuditInterceptor } from './audit.interceptor';

function getClient(): { query: jest.Mock; release: jest.Mock } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Pool } = require('pg') as { Pool: { _client: { query: jest.Mock; release: jest.Mock } } };
  return Pool._client;
}

function makeCtx(
  method: string,
  path = '/v1/patients',
  params: Record<string, string> = {},
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method,
        path,
        ip: '127.0.0.1',
        params,
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
        const { query } = getClient();
        expect(query).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO audit_log'),
          expect.arrayContaining(['t-1', 'u-1', 'clinician', 'CREATE_PATIENT']),
        );
        done();
      }, 30);
    });
  });

  it('wraps the INSERT in a BEGIN / COMMIT transaction', (done) => {
    const handler: CallHandler = { handle: () => of({}) };

    interceptor.intercept(makeCtx('POST'), handler).subscribe(() => {
      setTimeout(() => {
        const stmts = getClient().query.mock.calls.map((c: unknown[]) => String(c[0]));
        expect(stmts[0]).toBe('BEGIN');
        expect(stmts[stmts.length - 1]).toBe('COMMIT');
        done();
      }, 30);
    });
  });

  it('writes UPDATE action on PATCH', (done) => {
    const handler: CallHandler = { handle: () => of({}) };

    interceptor.intercept(makeCtx('PATCH'), handler).subscribe(() => {
      setTimeout(() => {
        const { query } = getClient();
        const insertCall = query.mock.calls.find((c: unknown[]) =>
          String(c[0]).includes('INSERT INTO audit_log'),
        );
        expect(insertCall![1]).toContain('UPDATE_PATIENT');
        done();
      }, 30);
    });
  });

  it('skips audit on GET', (done) => {
    const handler: CallHandler = { handle: () => of([]) };

    interceptor.intercept(makeCtx('GET'), handler).subscribe(() => {
      setTimeout(() => {
        expect(getClient().query).not.toHaveBeenCalled();
        done();
      }, 30);
    });
  });

  it('records resourceId from params and stores no raw PHI', (done) => {
    const handler: CallHandler = { handle: () => of(null) };

    interceptor
      .intercept(makeCtx('DELETE', '/v1/patients/p-1', { id: 'p-1' }), handler)
      .subscribe(() => {
        setTimeout(() => {
          const { query } = getClient();
          const insertCall = query.mock.calls.find((c: unknown[]) =>
            String(c[0]).includes('INSERT INTO audit_log'),
          );
          const payload = insertCall![1][5] as string | null;
          expect(payload).toBe(JSON.stringify({ resourceId: 'p-1' }));
          done();
        }, 30);
      });
  });

  it('stores null payload when no resource id is present in the route', (done) => {
    const handler: CallHandler = { handle: () => of(null) };

    interceptor.intercept(makeCtx('DELETE', '/v1/patients'), handler).subscribe(() => {
      setTimeout(() => {
        const { query } = getClient();
        const insertCall = query.mock.calls.find((c: unknown[]) =>
          String(c[0]).includes('INSERT INTO audit_log'),
        );
        expect(insertCall![1][5]).toBeNull();
        done();
      }, 30);
    });
  });
});
