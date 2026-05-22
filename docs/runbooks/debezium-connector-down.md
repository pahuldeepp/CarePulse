# Runbook: Debezium connector down

**Owner:** platform
**Severity:** page
**Linked SLO:** every projection SLO — Debezium is the WAL → Kafka relay (see [ADR-0003](../../adr/0003-debezium-cdc.md)).

## Symptoms

- Multiple `*_lag` SLOs burning at once.
- `kafka_connect_connector_status{connector="carepack-outbox-connector",state="RUNNING"} == 0`.
- jobs-worker reaper logs show it re-publishing stuck outbox rows (the fallback path).

## Diagnosis

```bash
curl -s http://localhost:8083/connectors/carepack-outbox-connector/status | jq
```

Look for `state: FAILED` and the `trace` field for the underlying cause. Common ones:

1. **Postgres replication slot full / WAL retention exceeded.**
   ```sql
   SELECT slot_name, active, restart_lsn,
          pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS lag_bytes
   FROM pg_replication_slots;
   ```
2. **Outbox table schema changed and connector wasn't restarted.** Look for SMT errors in the trace.
3. **Kafka Connect worker OOM.** Check `docker compose logs kafka-connect` for OOMKilled.
4. **Postgres credentials rotated** — `database.user` in [outbox-connector.json](../../infra/docker/debezium/outbox-connector.json) is stale.

## Mitigations

1. **Restart the task** (safest):
   ```bash
   curl -X POST http://localhost:8083/connectors/carepack-outbox-connector/restart
   ```
   Confirm it returns to `RUNNING` and lag stops growing.

2. **Re-register the connector** if config drifted:
   ```bash
   ./infra/docker/debezium/register-connector.sh
   ```

3. **Reaper buys time, doesn't replace Debezium.** The jobs-worker reaper re-publishes stuck rows on a 60s tick — that's fallback, not a sustained operating mode. Don't leave Debezium down for hours expecting the reaper to cover.

4. **Increase replication slot retention** if WAL exhaustion is the cause:
   ```sql
   ALTER SYSTEM SET max_slot_wal_keep_size = '10GB';
   SELECT pg_reload_conf();
   ```
   Then restart the connector.

## Rollback

Connector config is in git. To revert a bad config change:

```bash
git checkout HEAD~1 -- infra/docker/debezium/outbox-connector.json
./infra/docker/debezium/register-connector.sh
```

## Post-incident

- Postmortem in `docs/postmortems/YYYY-MM-DD-debezium-down.md`.
- Verify no outbox rows were missed: `SELECT COUNT(*) FROM outbox_events WHERE processed_at IS NULL AND created_at < now() - interval '5 minutes'` should be 0 after recovery.
