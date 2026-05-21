# Error-Budget Policy

**Status:** Draft — pending sign-off in S9.

Each service has an SLO (see [infra/slo/](../../infra/slo/)). The error budget is the allowable unreliability in the SLO window. This policy says what happens when the budget runs low.

## Tiers

| Budget remaining | What happens |
|---|---|
| > 50% | Normal feature velocity. |
| 25–50% | Caution. New risky changes require a reviewer who is not the author. |
| 10–25% | Reliability work prioritised. Non-urgent feature merges paused. |
| < 10% (or burn-rate page firing) | **Feature freeze.** Only reliability fixes, rollbacks, and dependency security patches merge until the service is back above 25%. |

## Roles

- **Service owner** (named in `slo.yaml`): accountable for the budget.
- **On-call**: declares incidents, runs runbooks, calls feature-freeze when burn-rate page fires.
- **Engineering lead**: signs off lifting a freeze.

## Triggers

- Fast-burn page (14.4× over 1h) → immediate incident channel, freeze candidate.
- Slow-burn ticket (6× over 6h) → triage within one business day.
- Monthly review: any service that exhausted its budget gets a postmortem and a reliability-investment proposal before the next sprint planning.

## Out of scope

- Per-tenant SLOs (deferred until multi-region — R7).
- External-API dependency SLOs (Stripe, EHR partners) — handled separately under vendor management.
