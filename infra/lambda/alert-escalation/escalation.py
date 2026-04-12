"""
alert-escalation — AWS Lambda (two handlers in one file)
=========================================================

stream_handler
--------------
Trigger: DynamoDB Streams — fires immediately on every INSERT to alerts_table.
Action:  For high/critical alerts, sends a message to SQS with a 15-minute
         delivery delay. SQS holds it precisely — no flex window.

check_handler
-------------
Trigger: SQS queue — message delivered exactly 15 minutes after alert creation.
Action:  Reads the alert from DynamoDB.
         - acknowledged_at is set → nurse saw it → do nothing.
         - acknowledged_at is null → nurse missed it → publish AlertEscalated
           to EventBridge so notification-service can page the senior nurse.

Why SQS delay instead of EventBridge Scheduler?
------------------------------------------------
EventBridge Scheduler has a +-5-minute flex window — unacceptable for a
clinical escalation that must fire at the 15-minute mark per NHS NEWS2 protocol.
SQS DelaySeconds is precise to the second. Max SQS delay is 900s (15 min)
which matches the escalation window exactly.
"""

import json
import logging
import os
from datetime import datetime, timezone

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

sqs = boto3.client("sqs")
events = boto3.client("events")
dynamo = boto3.resource("dynamodb")

DYNAMODB_TABLE = os.environ.get("DYNAMODB_TABLE", "carepulse-alerts")
EVENT_BUS_NAME = os.environ.get("EVENT_BUS_NAME", "carepulse-escalation")
ESCALATION_QUEUE_URL = os.environ.get("ESCALATION_QUEUE_URL", "")

ESCALATE_SEVERITIES = {"high", "critical"}


def stream_handler(event: dict, context: object) -> None:
    """Triggered immediately on every DynamoDB INSERT in alerts_table."""
    for record in event.get("Records", []):
        if record.get("eventName") != "INSERT":
            continue

        new_image = record["dynamodb"].get("NewImage", {})
        alert_id = new_image.get("alert_id", {}).get("S")
        tenant_id = new_image.get("tenant_id", {}).get("S")
        severity = new_image.get("severity", {}).get("S", "low")

        if not alert_id or severity not in ESCALATE_SEVERITIES:
            continue

        sqs.send_message(
            QueueUrl=ESCALATION_QUEUE_URL,
            MessageBody=json.dumps(
                {"alert_id": alert_id, "tenant_id": tenant_id, "severity": severity}
            ),
            DelaySeconds=900,
            MessageGroupId=alert_id,
            MessageDeduplicationId=alert_id,
        )

        logger.info("escalation_queued alert_id=%s severity=%s", alert_id, severity)


def check_handler(event: dict, context: object) -> None:
    """Triggered by SQS exactly 15 minutes after alert creation."""
    for record in event.get("Records", []):
        body = json.loads(record["body"])
        alert_id = body["alert_id"]
        tenant_id = body["tenant_id"]
        severity = body["severity"]

        table = dynamo.Table(DYNAMODB_TABLE)
        item = table.get_item(Key={"alert_id": alert_id}).get("Item", {})

        if item.get("acknowledged_at"):
            logger.info("acknowledged alert_id=%s", alert_id)
            continue

        logger.warning(
            "escalating alert_id=%s severity=%s tenant_id=%s",
            alert_id,
            severity,
            tenant_id,
        )

        events.put_events(
            Entries=[
                {
                    "Source": "carepulse.alerts",
                    "DetailType": "AlertEscalated",
                    "EventBusName": EVENT_BUS_NAME,
                    "Detail": json.dumps(
                        {
                            "alert_id": alert_id,
                            "tenant_id": tenant_id,
                            "severity": severity,
                            "escalated_at": datetime.now(timezone.utc).isoformat(),
                        }
                    ),
                }
            ]
        )
