"""Tests for the FHIR bundle validator Lambda."""

import json
from unittest.mock import MagicMock, patch

from validator import _validate, handler


def test_valid_bundle_passes():
    bundle = {"resourceType": "Bundle", "type": "document", "entry": []}
    ok, reason = _validate(bundle)
    assert ok is True
    assert reason == "ok"


def test_wrong_resource_type_fails():
    bundle = {"resourceType": "Patient", "type": "document", "entry": []}
    ok, reason = _validate(bundle)
    assert ok is False
    assert "Patient" in reason


def test_missing_entry_fails():
    bundle = {"resourceType": "Bundle", "type": "document"}
    ok, reason = _validate(bundle)
    assert ok is False
    assert "entry" in reason


def test_missing_type_fails():
    bundle = {"resourceType": "Bundle", "entry": []}
    ok, reason = _validate(bundle)
    assert ok is False
    assert "type" in reason


def test_invalid_bundle_type_fails():
    bundle = {"resourceType": "Bundle", "type": "not-real", "entry": []}
    ok, reason = _validate(bundle)
    assert ok is False
    assert "not-real" in reason


def test_entry_not_list_fails():
    bundle = {"resourceType": "Bundle", "type": "document", "entry": "wrong"}
    ok, reason = _validate(bundle)
    assert ok is False
    assert "array" in reason


def test_all_valid_bundle_types_pass():
    valid_types = [
        "document", "message", "transaction", "transaction-response",
        "batch", "batch-response", "history", "searchset", "collection",
    ]
    for btype in valid_types:
        bundle = {"resourceType": "Bundle", "type": btype, "entry": []}
        ok, _ = _validate(bundle)
        assert ok is True, f"type '{btype}' should be valid"


def _s3_event(bucket: str, key: str) -> dict:
    return {"Records": [{"s3": {"bucket": {"name": bucket}, "object": {"key": key}}}]}


def test_handler_tags_valid_bundle_passed():
    bundle = {"resourceType": "Bundle", "type": "document", "entry": []}
    mock_body = MagicMock()
    mock_body.read.return_value = json.dumps(bundle).encode()

    with patch("validator.s3") as mock_s3:
        mock_s3.get_object.return_value = {"Body": mock_body}
        result = handler(_s3_event("bucket", "t/b.json"), {})

    assert result["results"][0]["status"] == "passed"
    tags = mock_s3.put_object_tagging.call_args.kwargs["Tagging"]["TagSet"]
    status_tag = next(t for t in tags if t["Key"] == "validation-status")
    assert status_tag["Value"] == "passed"


def test_handler_tags_invalid_bundle_failed():
    bundle = {"resourceType": "Patient"}
    mock_body = MagicMock()
    mock_body.read.return_value = json.dumps(bundle).encode()

    with patch("validator.s3") as mock_s3:
        mock_s3.get_object.return_value = {"Body": mock_body}
        result = handler(_s3_event("bucket", "t/bad.json"), {})

    assert result["results"][0]["status"] == "failed"


def test_handler_processes_multiple_records():
    bundle = {"resourceType": "Bundle", "type": "collection", "entry": []}
    mock_body = MagicMock()
    mock_body.read.return_value = json.dumps(bundle).encode()

    event = {
        "Records": [
            {"s3": {"bucket": {"name": "b"}, "object": {"key": f"t/bundle-{i}.json"}}}
            for i in range(3)
        ]
    }
    with patch("validator.s3") as mock_s3:
        mock_s3.get_object.return_value = {"Body": mock_body}
        result = handler(event, {})

    assert result["validated"] == 3


def test_handler_continues_on_s3_read_error():
    good_bundle = {"resourceType": "Bundle", "type": "document", "entry": []}
    good_body = MagicMock()
    good_body.read.return_value = json.dumps(good_bundle).encode()

    event = {
        "Records": [
            {"s3": {"bucket": {"name": "b"}, "object": {"key": "bad.json"}}},
            {"s3": {"bucket": {"name": "b"}, "object": {"key": "good.json"}}},
        ]
    }

    def get_side_effect(Bucket, Key):  # noqa: N803
        if Key == "bad.json":
            raise Exception("S3 access denied")
        return {"Body": good_body}

    with patch("validator.s3") as mock_s3:
        mock_s3.get_object.side_effect = get_side_effect
        result = handler(event, {})

    statuses = {r["key"]: r["status"] for r in result["results"]}
    assert statuses["bad.json"] == "error"
    assert statuses["good.json"] == "passed"
