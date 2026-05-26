# Postmortem — [Short title, e.g. "workflow-alerts crash 2026-06-01"]

> **Blameless principle:** This document focuses on what failed in the
> *system*, not who made a mistake. The goal is to prevent recurrence,
> not to assign blame.

---

## Summary

| Field | Value |
|-------|-------|
| **Date** | YYYY-MM-DD |
| **Duration** | X hours Y minutes |
| **Severity** | P0 / P1 / P2 |
| **Services affected** | e.g. workflow-alerts, patient-service |
| **Tenants affected** | e.g. All / tenant-abc |
| **Patient impact** | e.g. Alert delivery delayed 8 min for all patients |
| **Detected by** | Probe alert / user report / engineer |
| **On-call engineer** | Name |
| **Incident commander** | Name |

---

## Timeline (all times UTC)

| Time | Event |
|------|-------|
| HH:MM | Incident begins (what broke / what changed) |
| HH:MM | First symptom observed (probe down / user complaint) |
| HH:MM | Alert fired — who was paged |
| HH:MM | Engineer acknowledged page |
| HH:MM | Root cause identified |
| HH:MM | Mitigation applied (restart / rollback / hotfix) |
| HH:MM | Service restored, probes green |
| HH:MM | Incident closed |

---

## Impact

### Patient / Clinical Impact
<!-- Were patient alerts delayed or lost? Were clinicians unable to access data?
     Be specific — which wards, how many patients, what was the clinical risk. -->

### Tenant Impact
<!-- Which tenants were affected and for how long? -->

### Data Impact
<!-- Was any data lost or corrupted? Were outbox events replayed correctly? -->

---

## Root Cause

### What happened
<!-- One paragraph, plain English. No jargon. What broke and why. -->

### Why it wasn't caught earlier
<!-- What monitoring, test, or process would have caught this sooner? -->

### Contributing factors
<!-- List the conditions that made this incident possible -->
- [ ] Missing test coverage
- [ ] No alert for this failure mode
- [ ] Config change without review
- [ ] Dependency failure (Kafka / Postgres / Redis / AWS)
- [ ] Deployment without canary
- [ ] Other: ___

---

## Detection

| Metric | Value |
|--------|-------|
| **Time to detect (TTD)** | X min (from incident start to first alert) |
| **Time to acknowledge (TTA)** | X min (from alert to engineer response) |
| **Time to mitigate (TTM)** | X min (from acknowledge to service restored) |
| **Total incident duration** | X min |

### How was it detected?
- [ ] `ServiceHealthProbeDown` alert (Blackbox Exporter)
- [ ] `ServiceErrorBudgetFastBurn` alert (burn-rate rule)
- [ ] Grafana SLO dashboard
- [ ] User / nurse complaint
- [ ] Engineer noticed during routine check
- [ ] Other: ___

---

## Resolution

### Immediate mitigation
<!-- What was done to stop the bleeding — restart, rollback, feature flag off -->

### Permanent fix
<!-- What code/config/infra change prevents recurrence -->

---

## Action Items

| # | Action | Owner | Due date | Status |
|---|--------|-------|----------|--------|
| 1 | Add alert rule for ___ failure mode | @engineer | YYYY-MM-DD | open |
| 2 | Add test coverage for ___ | @engineer | YYYY-MM-DD | open |
| 3 | Update runbook for ___ | @engineer | YYYY-MM-DD | open |

---

## Lessons Learned

### What went well
<!-- What parts of the response worked? What monitoring caught it faster than expected? -->

### What went poorly
<!-- What slowed down detection or resolution? -->

### Where we got lucky
<!-- What almost made this worse? What would have happened if X hadn't been in place? -->

---

## Appendix

### Relevant logs
```
# paste key log lines here
```

### Relevant metrics
<!-- Link to Grafana snapshot or paste PromQL query + result -->

### Related incidents
<!-- Links to previous postmortems for the same service or failure mode -->
