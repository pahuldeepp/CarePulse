"""
CarePulse CDK stack.

Provisions:
  - S3 bucket         fhir-bundles (versioned, AES-256, lifecycle: 90d→IA, 365d→Glacier)
  - DynamoDB table    carepulse-telemetry  (device_id PK, timestamp SK, 30-day TTL, Streams)
  - DynamoDB table    carepulse-alerts     (alert_id PK, Streams NEW_IMAGE)
  - SQS FIFO queue    carepulse-escalation (delivery_delay=900s, DLQ, content-based dedup)
  - EventBridge bus   carepulse-escalation
  - Lambda            fhir-validator       (S3 ObjectCreated trigger)
  - Lambda            alert-stream-handler (DynamoDB Streams trigger on alerts table)
  - Lambda            alert-check-handler  (SQS trigger, fires 15 min after alert INSERT)
  - EventBridge rule  AlertEscalated       (carepulse.alerts → escalation bus)
"""

from aws_cdk import (
    Duration,
    RemovalPolicy,
    Stack,
    aws_dynamodb as dynamodb,
    aws_events as events,
    aws_lambda as _lambda,
    aws_lambda_event_sources as lambda_events,
    aws_s3 as s3,
    aws_s3_notifications as s3n,
    aws_sqs as sqs,
)
from constructs import Construct


class CarePulseStack(Stack):
    def __init__(
        self, scope: Construct, construct_id: str, env_name: str = "dev", **kwargs
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        is_prod = env_name == "prod"
        removal = RemovalPolicy.RETAIN if is_prod else RemovalPolicy.DESTROY

        # ── S3: FHIR bundle store ─────────────────────────────────────────────
        # Tenant-scoped key: {tenant_id}/{bundle_id}.json
        # AES-256 server-side encryption; versioning for audit trail.
        # Lifecycle: move to IA after 90 days, Glacier after 365 — balances
        # HIPAA retention (6 years) against storage cost.
        fhir_bucket = s3.Bucket(
            self,
            "FhirBucket",
            bucket_name=f"carepulse-fhir-{env_name}-{self.account}",
            versioned=True,
            encryption=s3.BucketEncryption.S3_MANAGED,  # AES-256
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            removal_policy=removal,
            auto_delete_objects=not is_prod,
            lifecycle_rules=[
                s3.LifecycleRule(
                    transitions=[
                        s3.Transition(
                            storage_class=s3.StorageClass.INFREQUENT_ACCESS,
                            transition_after=Duration.days(90),
                        ),
                        s3.Transition(
                            storage_class=s3.StorageClass.GLACIER,
                            transition_after=Duration.days(365),
                        ),
                    ]
                )
            ],
        )

        # ── DynamoDB: raw telemetry ───────────────────────────────────────────
        # PK: device_id, SK: timestamp (RFC3339Nano) — enables time-range queries.
        # PAY_PER_REQUEST: telemetry is bursty and unpredictable across wards.
        # TTL: auto-delete after 30 days (~780M rows/month — too expensive to keep).
        # Streams: NEW_AND_OLD_IMAGES retained for future CDC fanout (S5).
        telemetry_table = dynamodb.Table(
            self,
            "TelemetryTable",
            table_name=f"carepulse-telemetry-{env_name}",
            partition_key=dynamodb.Attribute(
                name="device_id", type=dynamodb.AttributeType.STRING
            ),
            sort_key=dynamodb.Attribute(
                name="timestamp", type=dynamodb.AttributeType.STRING
            ),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            time_to_live_attribute="ttl",
            stream=dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            removal_policy=removal,
        )

        # ── DynamoDB: alerts ──────────────────────────────────────────────────
        # PK: alert_id — DynamoDB Streams fires stream_handler Lambda on INSERT.
        # Using DynamoDB (not Postgres) so Streams can trigger Lambda natively
        # without needing Debezium CDC infrastructure (planned for S5/S6).
        alerts_table = dynamodb.Table(
            self,
            "AlertsTable",
            table_name=f"carepulse-alerts-{env_name}",
            partition_key=dynamodb.Attribute(
                name="alert_id", type=dynamodb.AttributeType.STRING
            ),
            billing_mode=dynamodb.BillingMode.PAY_PER_REQUEST,
            stream=dynamodb.StreamViewType.NEW_IMAGE,
            removal_policy=removal,
        )

        # ── SQS: escalation queue (FIFO, precise 15-min delay) ─────────────────
        # Why SQS DelaySeconds=900 instead of EventBridge Scheduler?
        # EventBridge Scheduler has a ±5-min flex window — unacceptable for
        # clinical escalation that must fire at the 15-min mark per NHS NEWS2.
        # SQS DelaySeconds is precise to the second. Max=900s = exactly 15 min.
        escalation_dlq = sqs.Queue(
            self,
            "EscalationDLQ",
            queue_name=f"carepulse-escalation-dlq-{env_name}.fifo",
            fifo=True,
            content_based_deduplication=True,
            removal_policy=removal,
        )

        escalation_queue = sqs.Queue(
            self,
            "EscalationQueue",
            queue_name=f"carepulse-escalation-{env_name}.fifo",
            fifo=True,
            content_based_deduplication=True,
            delivery_delay=Duration.seconds(900),
            dead_letter_queue=sqs.DeadLetterQueue(
                max_receive_count=3,
                queue=escalation_dlq,
            ),
            removal_policy=removal,
        )

        # ── EventBridge: escalation bus ───────────────────────────────────────
        escalation_bus = events.EventBus(
            self,
            "EscalationBus",
            event_bus_name=f"carepulse-escalation-{env_name}",
        )

        # ── Lambda: FHIR validator ────────────────────────────────────────────
        # Fires async on every S3 ObjectCreated — keeps POST /fhir/R4/Bundle fast.
        # EHR systems check the S3 tag before downloading the bundle.
        fhir_validator_fn = _lambda.Function(
            self,
            "FhirValidator",
            function_name=f"carepulse-fhir-validator-{env_name}",
            runtime=_lambda.Runtime.PYTHON_3_12,
            code=_lambda.Code.from_asset("../lambda/fhir-validator"),
            handler="validator.handler",
            environment={"FHIR_BUCKET": fhir_bucket.bucket_name},
        )
        fhir_bucket.grant_read_write(fhir_validator_fn)
        fhir_bucket.add_event_notification(
            s3.EventType.OBJECT_CREATED,
            s3n.LambdaDestination(fhir_validator_fn),
        )

        # ── Lambda: alert stream handler ──────────────────────────────────────
        # Fires immediately on every INSERT to alerts_table via DynamoDB Streams.
        # For high/critical alerts: enqueues to SQS with DelaySeconds=900.
        stream_handler_fn = _lambda.Function(
            self,
            "AlertStreamHandler",
            function_name=f"carepulse-alert-stream-{env_name}",
            runtime=_lambda.Runtime.PYTHON_3_12,
            code=_lambda.Code.from_asset("../lambda/alert-escalation"),
            handler="escalation.stream_handler",
            environment={
                "ESCALATION_QUEUE_URL": escalation_queue.queue_url,
                "DYNAMODB_TABLE": alerts_table.table_name,
            },
        )
        alerts_table.grant_stream_read(stream_handler_fn)
        escalation_queue.grant_send_messages(stream_handler_fn)
        stream_handler_fn.add_event_source(
            lambda_events.DynamoEventSource(
                alerts_table,
                starting_position=_lambda.StartingPosition.LATEST,
                batch_size=10,
                bisect_on_error=True,  # halve batch on error to isolate bad record
                retry_attempts=2,
            )
        )

        # ── Lambda: escalation check handler ─────────────────────────────────
        # Fires exactly 15 min after alert INSERT (SQS delivery delay).
        # Checks acknowledged_at in DynamoDB — if null, publishes AlertEscalated.
        check_handler_fn = _lambda.Function(
            self,
            "AlertCheckHandler",
            function_name=f"carepulse-alert-check-{env_name}",
            runtime=_lambda.Runtime.PYTHON_3_12,
            code=_lambda.Code.from_asset("../lambda/alert-escalation"),
            handler="escalation.check_handler",
            environment={
                "DYNAMODB_TABLE": alerts_table.table_name,
                "EVENT_BUS_NAME": escalation_bus.event_bus_name,
            },
        )
        alerts_table.grant_read_data(check_handler_fn)
        escalation_bus.grant_put_events_to(check_handler_fn)
        check_handler_fn.add_event_source(
            lambda_events.SqsEventSource(
                escalation_queue,
                batch_size=10,
                report_batch_item_failures=True,
            )
        )

        # ── EventBridge Rule: AlertEscalated → notification-service ───────────
        # Target (notification-service Lambda/SNS) wired in S3 when the
        # notification-service EventBridge consumer is built.
        events.Rule(
            self,
            "AlertEscalatedRule",
            event_bus=escalation_bus,
            event_pattern=events.EventPattern(
                source=["carepulse.alerts"],
                detail_type=["AlertEscalated"],
            ),
        )
