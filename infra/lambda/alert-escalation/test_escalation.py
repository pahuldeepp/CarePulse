"""Tests for alert escalation Lambda handlers."""

import json
from unittest.mock import MagicMock, patch

from escalation import check_handler, stream_handler


def _dynamo_record(alert_id: str, severity: str, event_name: str = "INSERT") -> dict:
    return {
        "eventName": event_name,
        "dynamodb": {
            "NewImage": {
                "alert_id": {"S": alert_id},
                "tenant_id": {"S": "tenant-001"},
                "severity": {"S": severity},
            }
        },
    }


def _sqs_record(alert_id: str, severity: str = "critical") -> dict:
    return {
        "body": json.dumps(
            {"alert_id": alert_id, "tenant_id": "tenant-001", "severity": severity}
        )
    }


def test_stream_handler_queues_critical_alert():
    with patch("escalation.sqs") as mock_sqs:
        stream_handler({"Records": [_dynamo_record("alert-1", "critical")]}, {})

    mock_sqs.send_message.assert_called_once()
    kwargs = mock_sqs.send_message.call_args.kwargs
    assert kwargs["DelaySeconds"] == 900
    assert json.loads(kwargs["MessageBody"])["alert_id"] == "alert-1"


def test_stream_handler_queues_high_alert():
    with patch("escalation.sqs") as mock_sqs:
        stream_handler({"Records": [_dynamo_record("alert-2", "high")]}, {})

    mock_sqs.send_message.assert_called_once()


def test_stream_handler_ignores_low_severity():
    with patch("escalation.sqs") as mock_sqs:
        stream_handler({"Records": [_dynamo_record("alert-3", "low")]}, {})

    mock_sqs.send_message.assert_not_called()


def test_stream_handler_ignores_non_insert_events():
    with patch("escalation.sqs") as mock_sqs:
        stream_handler(
            {"Records": [_dynamo_record("alert-4", "critical", event_name="MODIFY")]}, {}
        )

    mock_sqs.send_message.assert_not_called()


def test_check_handler_escalates_unacknowledged_alert():
    with patch("escalation.dynamo") as mock_dynamo, patch("escalation.events") as mock_events:
        table = MagicMock()
        table.get_item.return_value = {"Item": {"alert_id": "alert-5"}}
        mock_dynamo.Table.return_value = table

        check_handler({"Records": [_sqs_record("alert-5")]}, {})

    mock_events.put_events.assert_called_once()
    entry = mock_events.put_events.call_args.kwargs["Entries"][0]
    assert entry["DetailType"] == "AlertEscalated"
    assert json.loads(entry["Detail"])["alert_id"] == "alert-5"


def test_check_handler_skips_acknowledged_alert():
    with patch("escalation.dynamo") as mock_dynamo, patch("escalation.events") as mock_events:
        table = MagicMock()
        table.get_item.return_value = {
            "Item": {"alert_id": "alert-6", "acknowledged_at": "2026-04-12T14:10:00Z"}
        }
        mock_dynamo.Table.return_value = table

        check_handler({"Records": [_sqs_record("alert-6")]}, {})

    mock_events.put_events.assert_not_called()


def test_check_handler_sets_correct_event_source():
    with patch("escalation.dynamo") as mock_dynamo, patch("escalation.events") as mock_events:
        table = MagicMock()
        table.get_item.return_value = {"Item": {"alert_id": "alert-7"}}
        mock_dynamo.Table.return_value = table

        check_handler({"Records": [_sqs_record("alert-7", "critical")]}, {})

    entry = mock_events.put_events.call_args.kwargs["Entries"][0]
    assert entry["Source"] == "carepulse.alerts"


def test_check_handler_processes_multiple_records():
    with patch("escalation.dynamo") as mock_dynamo, patch("escalation.events") as mock_events:
        table = MagicMock()
        table.get_item.side_effect = [
            {"Item": {"alert_id": "a-1"}},
            {"Item": {"alert_id": "a-2", "acknowledged_at": "2026-04-12T14:10:00Z"}},
        ]
        mock_dynamo.Table.return_value = table

        check_handler({"Records": [_sqs_record("a-1"), _sqs_record("a-2")]}, {})

    assert mock_events.put_events.call_count == 1
