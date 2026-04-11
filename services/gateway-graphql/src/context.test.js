'use strict';

const { buildContext } = require('./context');

// ── helpers ───────────────────────────────────────────────────────────────────
function makeClient(overrides = {}) {
  return {
    query:   jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
    ...overrides,
  };
}

function makePool(client) {
  return { connect: jest.fn().mockResolvedValue(client) };
}

// ── buildContext ──────────────────────────────────────────────────────────────
describe('buildContext', () => {
  it('attaches user from req.user', () => {
    const user = { userId: 'u1', tenantId: 't1', role: 'ADMIN' };
    const { user: ctxUser } = buildContext({ req: { user }, pool: makePool(makeClient()) });
    expect(ctxUser).toBe(user);
  });
});

// ── tenantQuery ───────────────────────────────────────────────────────────────
describe('tenantQuery', () => {
  it('throws when tenantId is missing from JWT', async () => {
    const { tenantQuery } = buildContext({
      req:  { user: {} },
      pool: makePool(makeClient()),
    });
    await expect(tenantQuery('SELECT 1')).rejects.toThrow('No tenantId in JWT');
  });

  it('runs BEGIN → set_config → query → COMMIT in order', async () => {
    const rows   = [{ id: '1', tenant_id: 't1' }];
    const client = makeClient({
      query: jest.fn()
        .mockResolvedValueOnce({})           // BEGIN
        .mockResolvedValueOnce({})           // set_config
        .mockResolvedValueOnce({ rows })     // main query
        .mockResolvedValueOnce({}),          // COMMIT
    });
    const { tenantQuery } = buildContext({
      req:  { user: { tenantId: 't1' } },
      pool: makePool(client),
    });

    const result = await tenantQuery('SELECT * FROM patients WHERE id = $1', ['1']);

    expect(result).toEqual(rows);
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenNthCalledWith(2,
      'SELECT set_config($1, $2, true)',
      ['app.current_tenant_id', 't1'],
    );
    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back and re-throws on query error', async () => {
    const queryErr = new Error('query failed');
    const client   = makeClient({
      query: jest.fn()
        .mockResolvedValueOnce({})           // BEGIN
        .mockResolvedValueOnce({})           // set_config
        .mockRejectedValueOnce(queryErr)     // main query throws
        .mockResolvedValueOnce({}),          // ROLLBACK succeeds
    });
    const { tenantQuery } = buildContext({
      req:  { user: { tenantId: 't1' } },
      pool: makePool(client),
    });

    await expect(tenantQuery('SELECT 1')).rejects.toThrow('query failed');
    expect(client.release).toHaveBeenCalled();
  });

  it('preserves original error even when ROLLBACK itself fails', async () => {
    const queryErr    = new Error('original error');
    const rollbackErr = new Error('rollback also failed');
    const client      = makeClient({
      query: jest.fn()
        .mockResolvedValueOnce({})              // BEGIN
        .mockResolvedValueOnce({})              // set_config
        .mockRejectedValueOnce(queryErr)        // main query throws
        .mockRejectedValueOnce(rollbackErr),    // ROLLBACK also throws
    });
    const { tenantQuery } = buildContext({
      req:  { user: { tenantId: 't1' } },
      pool: makePool(client),
    });

    // Original error must be surfaced, NOT the rollback error
    await expect(tenantQuery('SELECT 1')).rejects.toThrow('original error');
    expect(client.release).toHaveBeenCalled();
  });
});
