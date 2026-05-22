# Runbook: Kafka consumer lag

**Owner:** platform
**Severity:** page (if alert path) | ticket (otherwise)
**Linked SLO:** any service with a `*_lag` SLO — most critically `workflow-alerts.dynamo_projection_lag`.

## Symptoms

- `kafka_consumer_records_lag_max` climbing in Grafana.
- Burn-rate alert on a service whose SLI is consumer lag.
- Downstream effects: missing alerts, stale projections, late risk scoring.

## Diagnosis

```bash
docker compose -f infra/docker/docker-compose.yml exec kafka \
  kafka-consumer-groups --bootstrap-server localhost:9092 \
  --describe --group <consumer-group>
```

Compare `CURRENT-OFFSET`, `LOG-END-OFFSET`, and `LAG`. Then ask:

1. **Is the producer rate spiking?** Check `kafka_topic_partition_current_offset` for the source topic. If yes — capacity issue, not a bug.
2. **Is the consumer stuck on one partition?** Lag concentrated on a single partition usually means a slow handler (DB query, downstream timeout) or a poison message that keeps retrying.
3. **Is the consumer process up?** `docker compose ps` / `kubectl get pods`. A crashed consumer looks identical to lag spikes.
4. **Is the DLQ filling?** If yes, the consumer is processing but failing; see [alert-projector code](../../services/workflow-alerts/src/alert-projector/alert-projector.service.ts) for the fail-fast-to-DLQ pattern.

## Mitigations

Ordered by reversibility:

1. **Restart the consumer pod.** Clears stuck rebalance state in ~80% of cases.
2. **Increase consumer concurrency.** Scale replicas (`kubectl scale --replicas=N`) — partitions must be ≥ replicas for it to help.
3. **Skip the bad offset (last resort).** `kafka-consumer-groups --reset-offsets --to-offset <N> --execute`. Document the skipped offsets; data loss is real.
4. **Pause producer.** Buy time to recover without growing the backlog further. Coordinate with the producer's owner.

## Rollback

If the lag started right after a deploy, roll back the consumer:

```bash
kubectl rollout undo deployment/<consumer>
```

Confirm: lag plateaus within 2 minutes, then trends down.

## Post-incident

- Postmortem in `docs/postmortems/YYYY-MM-DD-<consumer>-lag.md`.
- If DLQ filled, drain it with the project's reprocessor (e.g. `REPROCESS_DLQ_TOPICS` env on projection-builder).
