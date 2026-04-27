"""
search-indexer — consumes Kafka CDC events and bulk-indexes into OpenSearch.

S6: full indexer wired with patient + alert indices.
Flow: Postgres → Debezium → Kafka → this service → OpenSearch
"""

import asyncio
import json
import os

import structlog
from aiohttp import web
from aiokafka import AIOKafkaConsumer
from opensearchpy import AsyncOpenSearch, helpers

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ]
)
log = structlog.get_logger()

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP", "localhost:9092")
OPENSEARCH_URL = os.getenv("OPENSEARCH_URL", "http://localhost:9200")
CONSUMER_GROUP = os.getenv("CONSUMER_GROUP", "search-indexer")
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "200"))
FLUSH_INTERVAL = float(os.getenv("FLUSH_INTERVAL", "1.0"))

TOPICS = [
    "domain.patient.created",
    "domain.patient.updated",
    "domain.risk.scored",
]

# ── Index definitions ─────────────────────────────────────────────────────────

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
                "news2": {"type": "integer"},
                "qsofa": {"type": "integer"},
                "created_at": {"type": "date"},
            }
        }
    },
}


# ── OpenSearch setup ──────────────────────────────────────────────────────────


async def ensure_indices(client: AsyncOpenSearch) -> None:
    """Create indices with mappings if they do not already exist."""
    for name, body in INDICES.items():
        exists = await client.indices.exists(index=name)
        if not exists:
            await client.indices.create(index=name, body=body)
            log.info("index_created", index=name)


# ── Bulk indexer ──────────────────────────────────────────────────────────────


class BulkIndexer:
    """
    Accumulates documents and flushes to OpenSearch in bulk.
    Flushes when buffer reaches BATCH_SIZE or FLUSH_INTERVAL elapses — whichever
    comes first.  Non-fatal: a failed flush is logged and never re-raised so the
    Kafka consumer loop keeps running.
    """

    def __init__(self, client: AsyncOpenSearch) -> None:
        self._client = client
        self._buffer: list[dict] = []
        self._lock = asyncio.Lock()

    async def add(self, index: str, doc_id: str, doc: dict) -> None:
        """Buffer one document, flushing immediately if the batch is full."""
        async with self._lock:
            self._buffer.append({"_index": index, "_id": doc_id, **doc})
            if len(self._buffer) >= BATCH_SIZE:
                await self._flush()

    async def flush(self) -> None:
        """Public flush — acquires the lock then delegates to _flush."""
        async with self._lock:
            await self._flush()

    async def _flush(self) -> None:
        if not self._buffer:
            return
        batch = self._buffer.copy()
        self._buffer.clear()
        try:
            ok, errors = await helpers.async_bulk(self._client, batch, raise_on_error=False)
            if errors:
                log.error("bulk_index_errors", count=len(errors), sample=errors[:3])
            else:
                log.info("bulk_flushed", docs=ok)
        except Exception as exc:
            log.error("bulk_flush_failed", error=str(exc))

    async def run_flush_loop(self) -> None:
        """Background task — flushes on a fixed interval even if batch is not full."""
        while True:
            await asyncio.sleep(FLUSH_INTERVAL)
            await self.flush()


# ── Event routing ─────────────────────────────────────────────────────────────


def route_event(topic: str, value: dict) -> tuple[str, str, dict] | None:
    """
    Map a Kafka event to (index, doc_id, document).
    Returns None for events that should not be indexed.
    """
    if topic in ("domain.patient.created", "domain.patient.updated"):
        patient_id = value.get("patientId") or value.get("patient_id")
        if not patient_id:
            return None
        return (
            "carepack-patients",
            patient_id,
            {
                "tenant_id": value.get("tenantId") or value.get("tenant_id"),
                "mrn": value.get("mrn"),
                "name": f"{value.get('firstName', '')} {value.get('lastName', '')}".strip(),
                "ward": value.get("ward"),
                "status": "active",
                "updated_at": value.get("scored_at") or value.get("created_at"),
            },
        )

    if topic == "domain.risk.scored":
        if value.get("risk_level") not in ("high", "critical"):
            return None
        if not value.get("emit_alert", True):
            return None
        return (
            "carepack-alerts",
            f"{value['device_id']}:{value.get('scored_at', '')}",
            {
                "tenant_id": value.get("tenant_id"),
                "severity": value.get("risk_level"),
                "status": "open",
                "patient_id": value.get("device_id"),
                "news2": value.get("news2"),
                "qsofa": value.get("qsofa"),
                "created_at": value.get("scored_at"),
            },
        )

    return None


# ── Kafka consumer ────────────────────────────────────────────────────────────


async def consume(indexer: BulkIndexer) -> None:
    """
    Consume domain events from Kafka and route them into the BulkIndexer.
    Runs until the enclosing TaskGroup is cancelled.
    """
    consumer = AIOKafkaConsumer(
        *TOPICS,
        bootstrap_servers=KAFKA_BOOTSTRAP,
        group_id=CONSUMER_GROUP,
        value_deserializer=lambda v: json.loads(v.decode()),
        auto_offset_reset="earliest",
        enable_auto_commit=True,
    )
    await consumer.start()
    log.info("kafka_consumer_started", topics=TOPICS, group=CONSUMER_GROUP)

    try:
        async for msg in consumer:
            try:
                routed = route_event(msg.topic, msg.value)
                if routed is None:
                    continue
                index, doc_id, doc = routed
                await indexer.add(index, doc_id, doc)
            except Exception as exc:
                log.error(
                    "event_routing_failed",
                    topic=msg.topic,
                    error=str(exc),
                    raw=msg.value,
                )
    except asyncio.CancelledError:
        pass
    finally:
        await consumer.stop()
        log.info("kafka_consumer_stopped")


# ── Healthcheck ───────────────────────────────────────────────────────────────


async def healthz_handler(_request: web.Request) -> web.Response:
    """Liveness probe — always returns 200 if the process is running."""
    return web.Response(text="ok", status=200)


async def start_healthz() -> None:
    """Start the aiohttp healthcheck server on PORT (default 8084)."""
    app = web.Application()
    app.router.add_get("/healthz", healthz_handler)
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.getenv("PORT", "8084"))
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    log.info("healthz_listening", port=port)


# ── Entry point ───────────────────────────────────────────────────────────────


async def main() -> None:
    """Bootstrap OpenSearch indices then start the consumer and flush loop."""
    log.info("search_indexer_starting", kafka=KAFKA_BOOTSTRAP, opensearch=OPENSEARCH_URL)

    client = AsyncOpenSearch(hosts=[OPENSEARCH_URL])
    await ensure_indices(client)
    indexer = BulkIndexer(client)

    try:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(start_healthz())
            tg.create_task(indexer.run_flush_loop())
            tg.create_task(consume(indexer))
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
