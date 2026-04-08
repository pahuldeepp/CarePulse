# telemetry-ingest

| | |
|---|---|
| **Blueprint** | Part II §5 — High-throughput ingest |
| **Framework** | Go (`net/http`, goroutines) |
| **Language** | Go |
| **ORM** | No (batch writes / pgx as needed) |

**Responsibility:** Device telemetry ingest, validation, batch writes, transactional outbox.

**Status:** Scaffold only — `go mod init`, HTTP ingest handlers, Kafka/outbox integration.
