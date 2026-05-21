## Summary

<!-- 1-3 bullets: what changed and why -->

## Linked

- Sprint ticket: S?-??
- ADR(s):

## Self-verify (per CLAUDE.md)

- [ ] Service test suite green
- [ ] Type check passes (`tsc --noEmit` / `go build ./...` / `ruff check`)
- [ ] Kafka topic / DB table that this feature writes to actually receives data
- [ ] OTel trace_id present in log output

## Safety review

- [ ] No new dual-writes — projections are Kafka-consumer driven (ADR-0005)
- [ ] RLS variable is `app.current_tenant_id` (ADR-0001) in any new SQL
- [ ] No secrets in code or committed files
- [ ] Migrations are forward-compatible / rollback plan noted

## Test plan

- [ ] Unit tests cover happy + failure paths
- [ ] Integration test updated if the event flow changed
