"""
search-indexer — consumes Kafka events and bulk-indexes them into OpenSearch.

Topics consumed:
  domain.patient.created  → carepack-patients index
  domain.risk.scored      → carepack-patients (risk fields partial update)

Search endpoint:
  POST /search  { query, tenantId, size } → hits[]
"""

import asyncio
import json
import os
import sys
from typing import Any

import structlog
from aiohttp import web
from aiokafka import AIOKafkaConsumer
from opensearchpy import AsyncOpenSearch
from opensearchpy.helpers import async_bulk

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "packages", "otel-python"))

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
BATCH_SIZE = int(os.getenv("BATCH_SIZE", "200"))
FLUSH_INTERVAL = float(os.getenv("FLUSH_INTERVAL", "1.0"))
CONSUMER_GROUP = "search-indexer"
PATIENT_INDEX = "carepack-patients"

# ── Index mapping ─────────────────────────────────────────────────────────────
PATIENT_MAPPING = {
    "mappings": {
        "properties": {
            "tenant_id": {"type": "keyword"},
            "mrn": {"type": "keyword"},
            "full_name": {"type": "text", "fields": {"keyword": {"type": "keyword"}}},
            "ward": {"type": "keyword"},
            "status": {"type": "keyword"},
            "news2": {"type": "integer"},
            "risk_level": {"type": "keyword"},
            "updated_at": {"type": "date"},
        }
    }
}


# ── Bulk indexer ──────────────────────────────────────────────────────────────


class BulkIndexer:
    """
    Accumulates index/update actions and flushes to OpenSearch in bulk.
    Two flush triggers: BATCH_SIZE reached OR FLUSH_INTERVAL elapsed.
    """

    def __init__(self, client: AsyncOpenSearch):
        self._client = client
        self._buffer: list[dict] = []
        self._lock = asyncio.Lock()

    async def add_index(self, doc_id: str, doc: dict):
        async with self._lock:
            self._buffer.append(
                {
                    "_op_type": "index",
                    "_index": PATIENT_INDEX,
                    "_id": doc_id,
                    **doc,
                }
            )
            if len(self._buffer) >= BATCH_SIZE:
                await self._flush()

    async def add_update(self, doc_id: str, partial: dict):
        async with self._lock:
            self._buffer.append(
                {
                    "_op_type": "update",
                    "_index": PATIENT_INDEX,
                    "_id": doc_id,
                    "doc": partial,
                    "doc_as_upsert": True,
                }
            )
            if len(self._buffer) >= BATCH_SIZE:
                await self._flush()

    async def _flush(self):
        if not self._buffer:
            return
        batch = self._buffer.copy()
        self._buffer.clear()
        try:
            success, errors = await async_bulk(self._client, batch, raise_on_error=False)
            if errors:
                log.error("bulk_flush_errors", count=len(errors), errors=errors[:3])
            else:
                log.info("bulk_flush_ok", docs=success)
        except Exception as exc:
            log.error("bulk_flush_failed", error=str(exc))

    async def run_flush_loop(self):
        while True:
            await asyncio.sleep(FLUSH_INTERVAL)
            async with self._lock:
                await self._flush()


# ── Event handlers ────────────────────────────────────────────────────────────


async def handle_patient_created(indexer: BulkIndexer, payload: dict):
    patient_id = payload.get("patientId") or payload.get("patient_id")
    if not patient_id:
        log.warn("patient_created_missing_id")
        return
    doc = {
        "tenant_id": payload.get("tenantId") or payload.get("tenant_id", ""),
        "mrn": payload.get("mrn", ""),
        "full_name": f"{payload.get('firstName', '')} {payload.get('lastName', '')}".strip(),
        "ward": payload.get("ward", ""),
        "status": "active",
        "updated_at": payload.get("created_at") or payload.get("createdAt"),
    }
    await indexer.add_index(patient_id, doc)
    log.info("patient_indexed", patient_id=patient_id)


async def handle_risk_scored(indexer: BulkIndexer, payload: dict):
    patient_id = payload.get("patient_id")
    if not patient_id:
        return
    await indexer.add_update(
        patient_id,
        {
            "news2": int(payload.get("news2", 0)),
            "risk_level": payload.get("risk_level", "low"),
            "updated_at": payload.get("scored_at"),
        },
    )


# ── Kafka consumer ────────────────────────────────────────────────────────────

TOPIC_HANDLERS: dict[str, Any] = {
    "domain.patient.created": handle_patient_created,
    "domain.risk.scored": handle_risk_scored,
}


async def consume(indexer: BulkIndexer):
    consumer = AIOKafkaConsumer(
        *TOPIC_HANDLERS.keys(),
        bootstrap_servers=KAFKA_BOOTSTRAP,
        group_id=CONSUMER_GROUP,
        value_deserializer=lambda v: json.loads(v.decode()),
        auto_offset_reset="earliest",
    )
    await consumer.start()
    log.info("kafka_consumer_started", topics=list(TOPIC_HANDLERS.keys()))
    try:
        async for msg in consumer:
            handler = TOPIC_HANDLERS.get(msg.topic)
            if not handler:
                continue
            try:
                await handler(indexer, msg.value)
            except Exception as exc:
                log.error("handle_event_failed", topic=msg.topic, error=str(exc))
    except asyncio.CancelledError:
        pass
    finally:
        await consumer.stop()
        log.info("kafka_consumer_stopped")


# ── HTTP: healthz + search ────────────────────────────────────────────────────

_os_client: AsyncOpenSearch | None = None


async def healthz_handler(_request: web.Request) -> web.Response:
    return web.Response(text="ok", status=200)


async def search_handler(request: web.Request) -> web.Response:
    """
    POST /search
    Body: { "query": "Jane", "tenantId": "...", "size": 20 }
    Returns: { "hits": [ { id, mrn, full_name, ward, status, news2, risk_level } ] }
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid JSON"}, status=400)

    query_str = body.get("query", "")
    tenant_id = body.get("tenantId", "")
    size = min(int(body.get("size", 20)), 100)

    if not tenant_id:
        return web.json_response({"error": "tenantId required"}, status=400)

    os_query = {
        "size": size,
        "query": {
            "bool": {
                "must": [
                    {"term": {"tenant_id": tenant_id}},
                ],
                "should": [
                    {"match": {"full_name": {"query": query_str, "fuzziness": "AUTO"}}},
                    {"term": {"mrn": query_str}},
                ]
                if query_str
                else [{"match_all": {}}],
                "minimum_should_match": 1 if query_str else 0,
            }
        },
        "_source": ["id", "mrn", "full_name", "ward", "status", "news2", "risk_level", "updated_at"],
    }

    try:
        resp = await _os_client.search(index=PATIENT_INDEX, body=os_query)
        hits = [{"id": h["_id"], **h["_source"]} for h in resp["hits"]["hits"]]
        return web.json_response({"hits": hits, "total": resp["hits"]["total"]["value"]})
    except Exception as exc:
        log.error("opensearch_search_failed", error=str(exc))
        return web.json_response({"error": "search failed"}, status=502)


async def build_http_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/healthz", healthz_handler)
    app.router.add_post("/search", search_handler)
    return app


# ── Bootstrap ─────────────────────────────────────────────────────────────────


async def ensure_index(client: AsyncOpenSearch):
    exists = await client.indices.exists(index=PATIENT_INDEX)
    if not exists:
        await client.indices.create(index=PATIENT_INDEX, body=PATIENT_MAPPING)
        log.info("opensearch_index_created", index=PATIENT_INDEX)
    else:
        log.info("opensearch_index_exists", index=PATIENT_INDEX)


async def main():
    global _os_client

    log.info("search_indexer_starting", kafka=KAFKA_BOOTSTRAP, opensearch=OPENSEARCH_URL)

    _os_client = AsyncOpenSearch(
        hosts=[OPENSEARCH_URL],
        use_ssl=False,
        verify_certs=False,
    )

    await ensure_index(_os_client)

    indexer = BulkIndexer(_os_client)

    http_app = await build_http_app()
    runner = web.AppRunner(http_app)
    await runner.setup()
    port = int(os.getenv("PORT", "8087"))
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    log.info("search_indexer_listening", port=port)

    try:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(indexer.run_flush_loop())
            tg.create_task(consume(indexer))
    finally:
        await _os_client.close()
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
