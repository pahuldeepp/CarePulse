import os
import sys
from contextlib import asynccontextmanager

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "packages", "otel-python"))
from otel_bootstrap import configure_otel, instrument_fastapi  # noqa: E402

configure_otel()

import structlog
import uvicorn
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

log = structlog.get_logger()

# ── FHIR R4 resource models ───────────────────────────────────────────────────
# Full resource set wired in S12 (Patient, Observation, Device, Condition, Encounter)


class FHIRPatient(BaseModel):
    resourceType: str = "Patient"
    id: str
    meta: dict = {"profile": ["http://hl7.org/fhir/StructureDefinition/Patient"]}
    identifier: list[dict] = []
    name: list[dict] = []
    birthDate: str | None = None
    gender: str | None = None


class FHIRObservation(BaseModel):
    resourceType: str = "Observation"
    id: str
    status: str = "final"
    subject: dict  # reference to Patient
    effectiveDateTime: str
    valueQuantity: dict | None = None
    code: dict = {}


# ── FastAPI app ───────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("fhir_gateway_started")
    yield
    log.info("fhir_gateway_stopped")


app = FastAPI(title="fhir-gateway", version="0.1.0", lifespan=lifespan)
instrument_fastapi(app)


@app.get("/healthz")
async def health():
    return {"status": "ok"}


# ── FHIR Patient endpoints ────────────────────────────────────────────────────


@app.get("/fhir/R4/Patient/{patient_id}", response_model=FHIRPatient)
async def get_patient(patient_id: str):
    """
    FHIR R4 Patient read.
    S4: queries patient-service via gRPC and maps to FHIR resource.
    """
    log.info("fhir_patient_read", patient_id=patient_id)
    # S4: gRPC call to patient-service goes here
    raise HTTPException(status_code=501, detail="wired in S4")


@app.get("/fhir/R4/Patient")
async def search_patients(
    name: str | None = Query(None),
    identifier: str | None = Query(None),
    _count: int = Query(20, alias="_count"),
):
    """
    FHIR _search — standard search params.
    S12: full search implementation with tenant scoping.
    """
    log.info(
        "fhir_patient_search",
        has_name=bool(name),
        has_identifier=bool(identifier),
        requested_count=_count,
    )
    # S12: OpenSearch query goes here
    return {"resourceType": "Bundle", "type": "searchset", "total": 0, "entry": []}


# ── FHIR Observation endpoints ────────────────────────────────────────────────


@app.get("/fhir/R4/Observation/{obs_id}", response_model=FHIRObservation)
async def get_observation(obs_id: str):
    log.info("fhir_observation_read", obs_id=obs_id)
    raise HTTPException(status_code=501, detail="wired in S4")


# ── CDS Hooks (S12) ───────────────────────────────────────────────────────────


@app.get("/cds-services")
async def cds_discovery():
    """CDS Hooks discovery endpoint — lists available hooks."""
    return {
        "services": [
            {
                "hook": "patient-view",
                "id": "carepack-risk-alert",
                "title": "CarePulse Risk Alert",
                "description": "Surfaces high NEWS2/qSOFA scores inline in EHR",
            }
        ]
    }


@app.post("/cds-services/carepack-risk-alert")
async def cds_risk_alert(body: dict):
    """
    CDS Hook: called by EHR when clinician opens a patient chart.
    S12: calls risk-engine and returns cards if score is high.
    """
    log.info("cds_hook_called", hook="patient-view")
    # S12: call risk-engine, return FHIR cards if NEWS2 >= 5
    return {"cards": []}


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", 8002)),
        reload=False,
    )
