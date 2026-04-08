# patient-service

| | |
|---|---|
| **Blueprint** | Part II §5 — Core clinical domain |
| **Framework** | NestJS + Prisma |
| **Language** | TypeScript |
| **ORM** | Yes (Prisma) |

**Responsibility:** Patient CRUD, care plans, user management, domain logic, Postgres + RLS (`SET LOCAL app.current_tenant`).

**Status:** Scaffold only — `nest new` or equivalent, Prisma schema under this service.
