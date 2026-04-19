package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/rs/zerolog/log"
	"github.com/segmentio/kafka-go"
)

// DLQWriter routes poison messages to a dead-letter topic.
// Topic naming: original topic + ".dlq" (e.g. patient.created.dlq)
// Each DLQ message includes the original message plus failure metadata as headers.
type DLQWriter struct {
	writers map[string]*kafka.Writer // keyed by original topic
	brokers []string
}

// DLQHeader keys added to every DLQ message
const (
	DLQHeaderOriginalTopic  = "dlq-original-topic"
	DLQHeaderOriginalOffset = "dlq-original-offset"
	DLQHeaderFailedAt       = "dlq-failed-at"
	DLQHeaderErrorMessage   = "dlq-error"
	DLQHeaderRetryCount     = "dlq-retry-count"
)

func NewDLQWriter() *DLQWriter {
	brokers := strings.Split(envOrDefault("KAFKA_BROKERS", "localhost:9092"), ",")
	return &DLQWriter{
		writers: make(map[string]*kafka.Writer),
		brokers: brokers,
	}
}

// WriteToDLQ forwards a failed message to the DLQ topic for the original topic.
func (d *DLQWriter) WriteToDLQ(ctx context.Context, original kafka.Message, cause error, retries int) error {
	dlqTopic := original.Topic + ".dlq"

	// Lazy-init writer per topic
	if _, ok := d.writers[dlqTopic]; !ok {
		d.writers[dlqTopic] = &kafka.Writer{
			Addr:         kafka.TCP(d.brokers...),
			Topic:        dlqTopic,
			Balancer:     &kafka.LeastBytes{},
			RequiredAcks: kafka.RequireOne,
		}
	}

	// Build DLQ message: copy original + add failure headers
	headers := append(original.Headers,
		kafka.Header{Key: DLQHeaderOriginalTopic, Value: []byte(original.Topic)},
		kafka.Header{Key: DLQHeaderOriginalOffset, Value: []byte(fmt.Sprintf("%d", original.Offset))},
		kafka.Header{Key: DLQHeaderFailedAt, Value: []byte(time.Now().UTC().Format(time.RFC3339))},
		kafka.Header{Key: DLQHeaderErrorMessage, Value: []byte(cause.Error())},
		kafka.Header{Key: DLQHeaderRetryCount, Value: []byte(fmt.Sprintf("%d", retries))},
	)

	dlqMsg := kafka.Message{
		Key:     original.Key,
		Value:   original.Value,
		Headers: headers,
	}

	if err := d.writers[dlqTopic].WriteMessages(ctx, dlqMsg); err != nil {
		return fmt.Errorf("write to DLQ %s: %w", dlqTopic, err)
	}

	log.Warn().
		Str("original_topic", original.Topic).
		Str("dlq_topic", dlqTopic).
		Int64("original_offset", original.Offset).
		Str("error", cause.Error()).
		Int("retries", retries).
		Msg("message_routed_to_dlq")

	return nil
}

// Close flushes and closes all DLQ writers.
func (d *DLQWriter) Close() {
	for topic, w := range d.writers {
		if err := w.Close(); err != nil {
			log.Error().Err(err).Str("topic", topic).Msg("dlq writer close failed")
		}
	}
}

// ── DLQ Reprocessor ───────────────────────────────────────────────────────────
// StartDLQReprocessor reads from DLQ topics and re-emits original messages.
// Run this as a manual step when you want to replay failed messages after a fix.
// Controlled by REPROCESS_DLQ_TOPICS env var (comma-separated list of DLQ topics).
func StartDLQReprocessor(ctx context.Context) error {
	dlqTopicsStr := os.Getenv("REPROCESS_DLQ_TOPICS")
	if dlqTopicsStr == "" {
		log.Info().Msg("REPROCESS_DLQ_TOPICS not set — DLQ reprocessor inactive")
		<-ctx.Done()
		return nil
	}

	dlqTopics := strings.Split(dlqTopicsStr, ",")
	brokers := strings.Split(envOrDefault("KAFKA_BROKERS", "localhost:9092"), ",")

	// Writer for re-emitting messages back to original topics
	reEmitWriter := &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Balancer:     &kafka.LeastBytes{},
		RequiredAcks: kafka.RequireOne,
	}
	defer reEmitWriter.Close()

	for _, dlqTopic := range dlqTopics {
		dlqTopic = strings.TrimSpace(dlqTopic)
		log.Info().Str("dlq_topic", dlqTopic).Msg("dlq_reprocessor_starting")

		r := kafka.NewReader(kafka.ReaderConfig{
			Brokers:     brokers,
			GroupID:     envOrDefault("KAFKA_GROUP_ID", "projection-builder") + ".dlq-reprocessor",
			Topic:       dlqTopic,
			MinBytes:    1,
			MaxBytes:    10e6,
			StartOffset: kafka.FirstOffset,
		})
		defer r.Close()

		for {
			msg, err := r.FetchMessage(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return nil
				}
				log.Error().Err(err).Str("dlq_topic", dlqTopic).Msg("dlq fetch failed")
				continue
			}

			// Extract original topic from header
			var originalTopic string
			for _, h := range msg.Headers {
				if h.Key == DLQHeaderOriginalTopic {
					originalTopic = string(h.Value)
					break
				}
			}
			if originalTopic == "" {
				log.Warn().Int64("offset", msg.Offset).Msg("dlq message missing original topic header — skipping")
				if err := r.CommitMessages(ctx, msg); err != nil {
					log.Error().Err(err).Msg("dlq commit (skip) failed")
				}
				continue
			}

			// Envelope to track this was reprocessed
			metadata, _ := json.Marshal(map[string]string{
				"reprocessed_at": time.Now().UTC().Format(time.RFC3339),
				"dlq_topic":      dlqTopic,
			})

			reEmitMsg := kafka.Message{
				Topic: originalTopic,
				Key:   msg.Key,
				Value: msg.Value,
				Headers: append(msg.Headers,
					kafka.Header{Key: "dlq-reprocessed", Value: metadata},
				),
			}

			if err := reEmitWriter.WriteMessages(ctx, reEmitMsg); err != nil {
				log.Error().Err(err).
					Str("original_topic", originalTopic).
					Int64("offset", msg.Offset).
					Msg("dlq re-emit failed")
				continue
			}

			log.Info().
				Str("dlq_topic", dlqTopic).
				Str("original_topic", originalTopic).
				Int64("dlq_offset", msg.Offset).
				Msg("dlq_message_reprocessed")

			if err := r.CommitMessages(ctx, msg); err != nil {
				log.Error().Err(err).Msg("dlq commit (after reprocess) failed")
			}
		}
	}
	return nil
}
