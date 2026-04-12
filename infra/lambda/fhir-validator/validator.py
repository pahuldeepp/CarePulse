"""
fhir-validator — AWS Lambda
============================
Trigger: S3 ObjectCreated event (fires the moment a FHIR bundle lands in S3).

What it does
------------
1. Reads the uploaded JSON from S3.
2. Validates it against the FHIR R4 Bundle spec (required fields + type enum).
3. Tags the S3 object with validation-status = passed | failed.

Why Lambda here (not fhir-gateway)?
------------------------------------
fhir-gateway stores the bundle and returns immediately — the HTTP response
does not wait for validation. Lambda runs async after the upload, keeping
POST /fhir/R4/Bundle fast. EHR systems check the S3 tag before downloading.
"""

import json
import logging
from datetime import datetime, timezone

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client("s3")

VALID_BUNDLE_TYPES = {
    "document",
    "message",
    "transaction",
    "transaction-response",
    "batch",
    "batch-response",
    "history",
    "searchset",
    "collection",
}

REQUIRED_FIELDS = {"resourceType", "type", "entry"}


def _validate(bundle: dict) -> tuple[bool, str]:
    """Returns (is_valid, reason)."""
    if bundle.get("resourceType") != "Bundle":
        return False, f"resourceType is '{bundle.get('resourceType')}', expected 'Bundle'"

    missing = REQUIRED_FIELDS - bundle.keys()
    if missing:
        return False, f"missing required fields: {sorted(missing)}"

    if bundle["type"] not in VALID_BUNDLE_TYPES:
        return False, f"invalid bundle type: '{bundle['type']}'"

    if not isinstance(bundle.get("entry"), list):
        return False, "entry must be an array"

    return True, "ok"


def handler(event: dict, context: object) -> dict:
    """Called by S3 for every ObjectCreated event on the FHIR bucket."""
    results = []

    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        key = record["s3"]["object"]["key"]

        try:
            obj = s3.get_object(Bucket=bucket, Key=key)
            bundle = json.loads(obj["Body"].read())
        except Exception as exc:
            logger.error("read_failed bucket=%s key=%s error=%s", bucket, key, exc)
            results.append({"key": key, "status": "error", "reason": str(exc)})
            continue

        is_valid, reason = _validate(bundle)
        status = "passed" if is_valid else "failed"

        s3.put_object_tagging(
            Bucket=bucket,
            Key=key,
            Tagging={
                "TagSet": [
                    {"Key": "validation-status", "Value": status},
                    {"Key": "validated-at", "Value": datetime.now(timezone.utc).isoformat()},
                    {"Key": "validation-reason", "Value": reason},
                ]
            },
        )

        logger.info("validated key=%s status=%s reason=%s", key, status, reason)
        results.append({"key": key, "status": status, "reason": reason})

    return {"validated": len(results), "results": results}
