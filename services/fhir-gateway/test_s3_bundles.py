"""Tests for FHIR Bundle S3 storage endpoints in fhir-gateway."""

import json
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from main import app

TENANT = "tenant-001"
HEADERS = {"X-Tenant-ID": TENANT}

client = TestClient(app, raise_server_exceptions=True)


def _valid_bundle(bundle_id: str | None = None) -> dict:
    b = {"resourceType": "Bundle", "type": "document", "entry": []}
    if bundle_id:
        b["id"] = bundle_id
    return b


def _client_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}}, "operation")


# ── POST /fhir/R4/Bundle ──────────────────────────────────────────────────────


def test_store_bundle_returns_201():
    with patch("main.s3") as mock_s3:
        mock_s3.put_object.return_value = {}
        resp = client.post("/fhir/R4/Bundle", json=_valid_bundle(), headers=HEADERS)

    assert resp.status_code == 201
    assert "bundle_id" in resp.json()


def test_store_bundle_uses_aes256_encryption():
    with patch("main.s3") as mock_s3:
        mock_s3.put_object.return_value = {}
        client.post("/fhir/R4/Bundle", json=_valid_bundle(), headers=HEADERS)

    kwargs = mock_s3.put_object.call_args.kwargs
    assert kwargs["ServerSideEncryption"] == "AES256"


def test_store_bundle_uses_tenant_scoped_key():
    with patch("main.s3") as mock_s3:
        mock_s3.put_object.return_value = {}
        resp = client.post("/fhir/R4/Bundle", json=_valid_bundle(), headers=HEADERS)

    key = mock_s3.put_object.call_args.kwargs["Key"]
    assert key.startswith(f"{TENANT}/")
    assert resp.json()["key"] == key


def test_store_bundle_preserves_existing_id():
    with patch("main.s3") as mock_s3:
        mock_s3.put_object.return_value = {}
        resp = client.post("/fhir/R4/Bundle", json=_valid_bundle("bundle-xyz"), headers=HEADERS)

    assert resp.json()["bundle_id"] == "bundle-xyz"


def test_store_bundle_wrong_resource_type_returns_400():
    payload = {"resourceType": "Patient", "type": "document", "entry": []}
    resp = client.post("/fhir/R4/Bundle", json=payload, headers=HEADERS)
    assert resp.status_code == 400


def test_store_bundle_s3_error_returns_500():
    with patch("main.s3") as mock_s3:
        mock_s3.put_object.side_effect = _client_error("InternalError")
        resp = client.post("/fhir/R4/Bundle", json=_valid_bundle(), headers=HEADERS)

    assert resp.status_code == 500


# ── GET /fhir/R4/Bundle/{bundle_id} ──────────────────────────────────────────


def test_get_bundle_returns_fhir_json_content_type():
    body_mock = MagicMock()
    body_mock.read.return_value = json.dumps(_valid_bundle("b-1")).encode()

    with patch("main.s3") as mock_s3:
        mock_s3.get_object.return_value = {"Body": body_mock}
        resp = client.get("/fhir/R4/Bundle/b-1", headers=HEADERS)

    assert resp.status_code == 200
    assert "application/fhir+json" in resp.headers["content-type"]


def test_get_bundle_uses_tenant_scoped_key():
    body_mock = MagicMock()
    body_mock.read.return_value = json.dumps(_valid_bundle("b-2")).encode()

    with patch("main.s3") as mock_s3:
        mock_s3.get_object.return_value = {"Body": body_mock}
        client.get("/fhir/R4/Bundle/b-2", headers=HEADERS)

    kwargs = mock_s3.get_object.call_args.kwargs
    assert kwargs["Key"] == f"{TENANT}/b-2.json"


def test_get_bundle_not_found_returns_404():
    with patch("main.s3") as mock_s3:
        mock_s3.get_object.side_effect = _client_error("NoSuchKey")
        resp = client.get("/fhir/R4/Bundle/missing", headers=HEADERS)

    assert resp.status_code == 404


# ── GET /fhir/R4/Bundle/{bundle_id}/url ──────────────────────────────────────


def test_presigned_url_returns_url_and_expiry():
    with patch("main.s3") as mock_s3:
        mock_s3.generate_presigned_url.return_value = "https://s3.example.com/signed"
        resp = client.get("/fhir/R4/Bundle/b-3/url", headers=HEADERS)

    assert resp.status_code == 200
    data = resp.json()
    assert data["url"] == "https://s3.example.com/signed"
    assert data["expires_in"] == 900


def test_presigned_url_uses_tenant_scoped_key():
    with patch("main.s3") as mock_s3:
        mock_s3.generate_presigned_url.return_value = "https://s3.example.com/signed"
        client.get("/fhir/R4/Bundle/b-4/url", headers=HEADERS)

    params = mock_s3.generate_presigned_url.call_args[1]["Params"]
    assert params["Key"] == f"{TENANT}/b-4.json"


def test_presigned_url_s3_error_returns_500():
    with patch("main.s3") as mock_s3:
        mock_s3.generate_presigned_url.side_effect = _client_error("AccessDenied")
        resp = client.get("/fhir/R4/Bundle/b-5/url", headers=HEADERS)

    assert resp.status_code == 500
