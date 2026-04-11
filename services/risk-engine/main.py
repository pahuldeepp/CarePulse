import asyncio
import os
import sys
from contextlib import asynccontextmanager

# OTel bootstrap must run before any other imports that touch HTTP/structlog
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "packages", "otel-python"))
from otel_bootstrap import configure_otel, instrument_fastapi  # noqa: E402

configure_otel()

import structlog
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel, Field, field_validator

# ── Structured logging ────────────────────────────────────────────────────────
structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ]
)
log = structlog.get_logger()

# ── Domain models ─────────────────────────────────────────────────────────────


class TelemetryReading(BaseModel):
    device_id: str
    tenant_id: str
    respiratory_rate: float | None = None  # breaths/min  (NEWS2)
    spo2: float | None = None  # %            (NEWS2)
    heart_rate: float | None = None  # bpm          (NEWS2)
    systolic_bp: float | None = None  # mmHg         (NEWS2 + qSOFA)
    temperature: float | None = None  # °C           (NEWS2)
    consciousness: str | None = None  # A/V/P/U      (NEWS2)
    gcs: int | None = None  # 3-15         (qSOFA)

    @field_validator("heart_rate")
    @classmethod
    def heart_rate_positive(cls, v):
        if v is not None and v <= 0:
            raise ValueError("heart_rate must be > 0")
        return v

    @field_validator("gcs")
    @classmethod
    def gcs_range(cls, v):
        if v is not None and not (3 <= v <= 15):
            raise ValueError("gcs must be between 3 and 15")
        return v

    @field_validator("consciousness")
    @classmethod
    def consciousness_valid(cls, v):
        if v is not None and v.upper() not in ("A", "V", "P", "U"):
            raise ValueError("consciousness must be one of A, V, P, U")
        return v


class RiskScore(BaseModel):
    device_id: str
    tenant_id: str
    news2: int = Field(description="0-20, higher = more critical")
    qsofa: int = Field(description="0-3, ≥2 = high sepsis risk")
    risk_level: str = Field(description="low | medium | high | critical")


# ── NEWS2 scoring ─────────────────────────────────────────────────────────────
# National Early Warning Score 2 — UK standard for deterioration detection


def score_news2(r: TelemetryReading) -> int:
    score = 0

    if r.respiratory_rate is not None:
        if r.respiratory_rate <= 8:
            score += 3
        elif r.respiratory_rate <= 11:
            score += 1
        elif r.respiratory_rate <= 20:
            score += 0
        elif r.respiratory_rate <= 24:
            score += 2
        else:
            score += 3

    if r.spo2 is not None:
        if r.spo2 <= 91:
            score += 3
        elif r.spo2 <= 93:
            score += 2
        elif r.spo2 <= 95:
            score += 1

    if r.heart_rate is not None:
        if r.heart_rate <= 40:
            score += 3
        elif r.heart_rate <= 50:
            score += 1
        elif r.heart_rate <= 90:
            score += 0
        elif r.heart_rate <= 110:
            score += 1
        elif r.heart_rate <= 130:
            score += 2
        else:
            score += 3

    if r.systolic_bp is not None:
        if r.systolic_bp <= 90:
            score += 3
        elif r.systolic_bp <= 100:
            score += 2
        elif r.systolic_bp <= 110:
            score += 1
        elif r.systolic_bp <= 219:
            score += 0
        else:
            score += 3

    if r.temperature is not None:
        if r.temperature <= 35.0:
            score += 3
        elif r.temperature <= 36.0:
            score += 1
        elif r.temperature <= 38.0:
            score += 0
        elif r.temperature <= 39.0:
            score += 1
        else:
            score += 2

    if r.consciousness is not None:
        if r.consciousness.upper() != "A":
            score += 3

    return score


# ── qSOFA scoring ─────────────────────────────────────────────────────────────
# Quick Sepsis-related Organ Failure Assessment


def score_qsofa(r: TelemetryReading) -> int:
    score = 0
    if r.respiratory_rate is not None and r.respiratory_rate >= 22:
        score += 1
    if r.systolic_bp is not None and r.systolic_bp <= 100:
        score += 1
    if r.gcs is not None and r.gcs < 15:
        score += 1
    return score


# ── Risk level mapping ────────────────────────────────────────────────────────


def risk_level(news2: int, qsofa: int) -> str:
    if news2 >= 7 or qsofa >= 2:
        return "critical"
    if news2 >= 5:
        return "high"
    if news2 >= 1:
        return "medium"
    return "low"


# ── Kafka consumer (S4: wired to domain.telemetry.ingested) ──────────────────


async def start_kafka_consumer():
    # S4: aiokafka consumer on domain.telemetry.ingested goes here
    # publishes domain.risk.scored after scoring each reading
    log.info("kafka_consumer_stub", topic="domain.telemetry.ingested")


# ── FastAPI app ───────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    consumer_task = asyncio.create_task(start_kafka_consumer())
    log.info("risk_engine_started")
    yield
    consumer_task.cancel()
    log.info("risk_engine_stopped")


app = FastAPI(title="risk-engine", version="0.1.0", lifespan=lifespan)
instrument_fastapi(app)


@app.get("/healthz")
async def health():
    return {"status": "ok"}


@app.post("/v1/score", response_model=RiskScore)
async def score(reading: TelemetryReading):
    """Score a telemetry reading synchronously (used in tests + FHIR CDS Hooks)."""
    news2 = score_news2(reading)
    qsofa = score_qsofa(reading)
    level = risk_level(news2, qsofa)

    log.info("scored", device_id=reading.device_id, news2=news2, qsofa=qsofa, level=level)

    return RiskScore(
        device_id=reading.device_id,
        tenant_id=reading.tenant_id,
        news2=news2,
        qsofa=qsofa,
        risk_level=level,
    )


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", 8001)),
        reload=False,
    )
