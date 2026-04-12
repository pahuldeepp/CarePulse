package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/rs/zerolog/log"
)

const ttlDays = 30

// DynamoStore writes raw telemetry readings to DynamoDB.
//
// Table schema
//
//	PK  device_id  (partition key) — all readings for a specific device
//	SK  timestamp  (sort key, RFC3339Nano) — enables time-range queries
//	ttl            (Unix epoch seconds) — DynamoDB auto-deletes after 30 days
//
// Why DynamoDB and not Postgres?
// Telemetry arrives at up to 300 readings/sec across all wards.
// Over 30 days that is ~780 million rows — too expensive for Postgres storage.
// DynamoDB handles this write rate natively and TTL keeps the table lean.
type DynamoStore struct {
	client    *dynamodb.Client
	tableName string
}

// NewDynamoStore loads AWS config from the environment (IAM role / env vars).
func NewDynamoStore(ctx context.Context) (*DynamoStore, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}

	tableName := os.Getenv("DYNAMODB_TABLE")
	if tableName == "" {
		tableName = "carepulse-telemetry"
	}

	return &DynamoStore{
		client:    dynamodb.NewFromConfig(cfg),
		tableName: tableName,
	}, nil
}

// Put writes a single reading to DynamoDB.
// Errors are logged and swallowed — DynamoDB unavailability must never
// drop readings or cause the HTTP handler to return an error.
func (d *DynamoStore) Put(ctx context.Context, r Reading) {
	ttl := time.Now().Add(ttlDays * 24 * time.Hour).Unix()

	item := map[string]types.AttributeValue{
		"device_id": &types.AttributeValueMemberS{Value: r.DeviceID},
		"timestamp": &types.AttributeValueMemberS{Value: r.Timestamp.Format(time.RFC3339Nano)},
		"tenant_id": &types.AttributeValueMemberS{Value: r.TenantID},
		"metric":    &types.AttributeValueMemberS{Value: r.Metric},
		"value":     &types.AttributeValueMemberN{Value: fmt.Sprintf("%g", r.Value)},
		"ttl":       &types.AttributeValueMemberN{Value: fmt.Sprintf("%d", ttl)},
	}

	if _, err := d.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(d.tableName),
		Item:      item,
	}); err != nil {
		log.Error().
			Err(err).
			Str("device_id", r.DeviceID).
			Msg("dynamo_put_failed")
	}
}

// PutBatch writes multiple readings sequentially.
func (d *DynamoStore) PutBatch(ctx context.Context, readings []Reading) {
	for _, r := range readings {
		d.Put(ctx, r)
	}
}
