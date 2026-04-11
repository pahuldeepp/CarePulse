"""
search-indexer — consumes Kafka events and bulk-indexes them into OpenSearch.

S6: full indexer wired with patient + alert indices.
S11: OpenSearch added to Docker Compose.
"""

import asyncio
import os

import structlog
from aiohttp import web

# ── Structured logging ────────────────────────────────────────────────────────
structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ]
)
log = structlog.get_logger()

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP", "localhost:9092")
OPENSEARCH_URL = os.getenv("OPENSEARCH_URL", "http://localhost:9200")
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "200"))  # docs per bulk request
FLUSH_INTERVAL = float(os.getenv("FLUSH_INTERVAL", "1.0"))  # seconds

# ── Index definitions (S6) ────────────────────────────────────────────────────
INDICES = {
    "carepack-patients": {
        "mappings": {
            "properties": {
                "tenant_id": {"type": "keyword"},
                "mrn": {"type": "keyword"},
                "name": {"type": "text"},
                "ward": {"type": "keyword"},
                "status": {"type": "keyword"},
                "updated_at": {"type": "date"},
            }
        }
    },
    "carepack-alerts": {
        "mappings": {
            "properties": {
                "tenant_id": {"type": "keyword"},
                "severity": {"type": "keyword"},
                "status": {"type": "keyword"},
                "patient_id": {"type": "keyword"},
                "created_at": {"type": "date"},
            }
        }
    },
}

# ── Bulk indexer ──────────────────────────────────────────────────────────────


class BulkIndexer:
    """
    Accumulates documents into a buffer and flushes to OpenSearch in bulk.
    Same batching pattern as telemetry-ingest — collect then flush.
    """

    def __init__(self):
        self.buffer: list[dict] = []
        self._lock = asyncio.Lock()

    async def add(self, index: str, doc_id: str, doc: dict):
        async with self._lock:
            # OpenSearch bulk API needs action + document pairs
            self.buffer.append({"index": {"_index": index, "_id": doc_id}})
            self.buffer.append(doc)

            if len(self.buffer) >= BATCH_SIZE * 2:
                await self._flush()

    async def _flush(self):
        if not self.buffer:
            return
        batch = self.buffer.copy()
        self.buffer.clear()
        log.info("bulk_flush", docs=len(batch) // 2)
        # S6: opensearch_py bulk() call goes here

    async def run_flush_loop(self):
        """Background task — flushes on interval even if batch not full."""
        while True:
            await asyncio.sleep(FLUSH_INTERVAL)
            async with self._lock:
                await self._flush()


# ── Kafka consumer ────────────────────────────────────────────────────────────


async def consume(indexer: BulkIndexer):
    """
    S6: aiokafka consumer on domain.patient.* + domain.risk.scored topics.
    Routes each event to the correct OpenSearch index.
    """
    log.info("kafka_consumer_stub", bootstrap=KAFKA_BOOTSTRAP)

    # S6: real consumer wired here
    # topic routing:
    #   domain.patient.created  → carepack-patients
    #   domain.patient.updated  → carepack-patients
    #   domain.risk.scored      → carepack-alerts (high/critical only)

    await asyncio.sleep(999999)  # hold coroutine open until cancelled


# ── Entry point ───────────────────────────────────────────────────────────────


async def healthz_handler(_request):
    return web.Response(text="ok", status=200)


async def start_healthz():
    app = web.Application()
    app.router.add_get("/healthz", healthz_handler)
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.getenv("PORT", "8084"))
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    log.info("search_indexer_healthz_listening", port=port)


async def main():
    log.info("search_indexer_starting", kafka=KAFKA_BOOTSTRAP, opensearch=OPENSEARCH_URL)

    indexer = BulkIndexer()

    async with asyncio.TaskGroup() as tg:
        tg.create_task(start_healthz())
        tg.create_task(indexer.run_flush_loop())
        tg.create_task(consume(indexer))


if __name__ == "__main__":
    asyncio.run(main())
