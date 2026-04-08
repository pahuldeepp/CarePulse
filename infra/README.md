# infra/

**Blueprint:** Part VII (observability, CI/CD), Part IX (multi-region, capacity).

Suggested layout as you implement:

- `docker/` — local `docker-compose` for Postgres, PgBouncer, Kafka, Redis, etc.
- `k8s/` or `helm/` — workloads per service
- `terraform/` — cloud foundation (VPC, EKS, RDS, …)
- `ci/` — reusable GitHub Actions workflows

Nothing provisioned here yet — structure only.
