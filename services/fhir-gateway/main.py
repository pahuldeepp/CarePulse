import json
import os
import sys
import uuid
from contextlib import asynccontextmanager

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "packages", "otel-python"))
from otel_bootstrap import configure_otel, instrument_fastapi  # noqa: E402

configure_otel()

import boto3
import structlog
import uvicorn
from botocore.exceptions import ClientError
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ── S3: FHIR bundle store ─────────────────────────────────────────────────────
# Bundles land at {tenant_id}/{bundle_id}.json — tenant-scoped key prevents
# cross-tenant reads even if IAM is misconfigured.
s3 = boto3.client("s3")
FHIR_BUCKET = os.environ.get("FHIR_BUCKET", "carepulse-fhir-dev")
PRESIGNED_URL_EXPIRY = 900  # 15 minutes — matches NHS NEWS2 escalation window

log = structlog.get_logger()

# ── FHIR R4 resource models ───────────────────────────────────────────────────
# Full resource set wired in S12 (Patient, Observation, Device, Condition, Encounter)


class FHIRBundle(BaseModel):
    resourceType: str = "Bundle"
    id: str | None = None
    type: str
    entry: list = []


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


# ── FHIR Bundle endpoints ─────────────────────────────────────────────────────


@app.post("/fhir/R4/Bundle", status_code=201)
async def store_bundle(
    bundle: FHIRBundle,
    x_tenant_id: str = Header(..., alias="X-Tenant-ID"),
):
    """
    Store a FHIR R4 Bundle in S3.

    Returns immediately after upload — validation runs async via the
    fhir-validator Lambda triggered by S3 ObjectCreated. EHR systems
    poll the S3 tag validation-status before downloading.
    """
    if bundle.resourceType != "Bundle":
        raise HTTPException(
            status_code=400,
            detail=f"resourceType must be 'Bundle', got '{bundle.resourceType}'",
        )

    bundle_id = bundle.id or str(uuid.uuid4())
    key = f"{x_tenant_id}/{bundle_id}.json"

    try:
        s3.put_object(
            Bucket=FHIR_BUCKET,
            Key=key,
            Body=json.dumps(bundle.model_dump()),
            ContentType="application/fhir+json",
            ServerSideEncryption="AES256",
        )
    except ClientError as exc:
        log.error("fhir_bundle_store_failed", key=key, error=str(exc))
        raise HTTPException(status_code=500, detail="failed to store bundle") from exc

    log.info("fhir_bundle_stored", bundle_id=bundle_id, tenant_id=x_tenant_id, key=key)
    return {"bundle_id": bundle_id, "key": key}


@app.get("/fhir/R4/Bundle/{bundle_id}")
async def get_bundle(
    bundle_id: str,
    x_tenant_id: str = Header(..., alias="X-Tenant-ID"),
):
    """
    Retrieve a FHIR R4 Bundle from S3.
    Tenant-scoped key prevents cross-tenant reads.
    """
    key = f"{x_tenant_id}/{bundle_id}.json"

    try:
        obj = s3.get_object(Bucket=FHIR_BUCKET, Key=key)
        body = json.loads(obj["Body"].read())
    except ClientError as exc:
        error_code = exc.response["Error"]["Code"]
        if error_code in ("NoSuchKey", "404"):
            raise HTTPException(status_code=404, detail="bundle not found") from exc
        log.error("fhir_bundle_get_failed", key=key, error=str(exc))
        raise HTTPException(status_code=500, detail="failed to retrieve bundle") from exc

    return JSONResponse(content=body, media_type="application/fhir+json")


@app.get("/fhir/R4/Bundle/{bundle_id}/url")
async def get_bundle_presigned_url(
    bundle_id: str,
    x_tenant_id: str = Header(..., alias="X-Tenant-ID"),
):
    """
    Return a presigned S3 URL (15-min expiry) so EHR systems can download
    the bundle directly — avoids routing large files through the gateway.
    """
    key = f"{x_tenant_id}/{bundle_id}.json"

    try:
        url = s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": FHIR_BUCKET, "Key": key},
            ExpiresIn=PRESIGNED_URL_EXPIRY,
        )
    except ClientError as exc:
        log.error("fhir_bundle_presign_failed", key=key, error=str(exc))
        raise HTTPException(status_code=500, detail="failed to generate presigned URL") from exc

    return {"url": url, "expires_in": PRESIGNED_URL_EXPIRY}


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", 8002)),
        reload=False,
    )
