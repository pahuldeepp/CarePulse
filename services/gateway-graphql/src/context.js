'use strict';

/**
 * Builds the GraphQL context object for every request.
 * - Attaches the authenticated user (set by authMiddleware).
 * - Exposes tenantQuery() which scopes every DB call to the correct tenant
 *   by setting app.current_tenant_id before the query runs (Postgres RLS).
 */
function buildContext({ req, pool }) {
  const user = req.user; // populated by authMiddleware

  /**
   * Runs a parameterised query scoped to the current tenant.
   * Sets SET LOCAL app.current_tenant_id inside a transaction so
   * Postgres RLS policies fire automatically.
   *
   * Usage:
   *   const rows = await ctx.tenantQuery(
   *     'SELECT * FROM patient_dashboard_projection WHERE id = $1',
   *     [patientId]
   *   );
   */
  async function tenantQuery(sql, params = []) {
    if (!user?.tenantId) throw new Error('No tenantId in JWT');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Use set_config() with parameterised call — prevents SQL injection
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_tenant_id',
        user.tenantId,
      ]);
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result.rows;
    } catch (err) {
      // Preserve original error even if ROLLBACK itself fails
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('ROLLBACK failed:', rollbackErr);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  return { user, tenantQuery };
}

module.exports = { buildContext };
