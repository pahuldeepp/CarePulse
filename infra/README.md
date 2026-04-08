# infra/

**Blueprint:** Part VII (observability, CI/CD), Part IX (multi-region, capacity).

In this **monorepo**, each service under `services/<name>/` typically owns its **Dockerfile**; this folder holds **shared** pieces:

- `docker/` — root `docker-compose` for local Postgres, Kafka, Redis, etc.
- `k8s/` or `helm/` — charts that reference images built from this repo (path-filtered CI).
- `terraform/` — cloud foundation (VPC, EKS, RDS, …).
- `ci/` — reusable GitHub Actions workflows (matrix or path filters per `services/*`).

Nothing provisioned here yet — structure only.
