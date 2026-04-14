// replay-projection resets a Kafka consumer group to offset 0 and truncates
// the corresponding Postgres projection table so the read-model can be rebuilt
// cleanly from the full event log.
//
// Usage:
//
//	go run ./scripts/replay-projection \
//	  --group projection-builder \
//	  --topic patient.created \
//	  --tables patient_dashboard_projection,processed_events
//
// Steps it performs:
//
//	1. Connects to Kafka, deletes the consumer group (offset reset to 0)
//	2. Connects to Postgres, truncates the named projection tables
//	3. Prints instructions to restart the service
//
// WARNING: stop the consumer service BEFORE running this script.
// Running while the consumer is active will cause a race condition.

package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"github.com/segmentio/kafka-go"
)

func main() {
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stdout, TimeFormat: time.RFC3339})

	var (
		brokers = flag.String("brokers", envOr("KAFKA_BOOTSTRAP", "localhost:9092"), "Kafka bootstrap brokers")
		group   = flag.String("group", "", "Consumer group ID to reset (required)")
		topic   = flag.String("topic", "", "Topic to seek to offset 0 (required)")
		tables  = flag.String("tables", "", "Comma-separated Postgres tables to truncate (required)")
		dbURL   = flag.String("db", envOr("DATABASE_URL", "postgres://carepack:carepack@localhost:5432/carepack"), "Postgres connection URL")
		dryRun  = flag.Bool("dry-run", false, "Print what would happen without making changes")
	)
	flag.Parse()

	if *group == "" || *topic == "" || *tables == "" {
		fmt.Fprintln(os.Stderr, "ERROR: --group, --topic, and --tables are all required")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "Examples:")
		fmt.Fprintln(os.Stderr, "  # Reset patient dashboard projection")
		fmt.Fprintln(os.Stderr, "  go run ./scripts/replay-projection \\")
		fmt.Fprintln(os.Stderr, "    --group projection-builder \\")
		fmt.Fprintln(os.Stderr, "    --topic patient.created \\")
		fmt.Fprintln(os.Stderr, "    --tables patient_dashboard_projection,processed_events")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  # Reset risk score projection")
		fmt.Fprintln(os.Stderr, "  go run ./scripts/replay-projection \\")
		fmt.Fprintln(os.Stderr, "    --group projection-builder-risk \\")
		fmt.Fprintln(os.Stderr, "    --topic domain.risk.scored \\")
		fmt.Fprintln(os.Stderr, "    --tables patient_risk_latest,processed_events")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  # Reset all projections (run twice with each group)")
		os.Exit(1)
	}

	tableList := splitTrim(*tables)

	log.Info().
		Str("group", *group).
		Str("topic", *topic).
		Strs("tables", tableList).
		Bool("dry_run", *dryRun).
		Msg("replay-projection starting")

	if *dryRun {
		fmt.Println("\n── DRY RUN — no changes will be made ──────────────────────")
		fmt.Printf("  Would delete consumer group : %s\n", *group)
		fmt.Printf("  Would seek topic to offset 0: %s\n", *topic)
		for _, t := range tableList {
			fmt.Printf("  Would TRUNCATE TABLE        : %s\n", t)
		}
		fmt.Println("────────────────────────────────────────────────────────────\n")
		return
	}

	ctx := context.Background()

	// ── Step 1: Delete consumer group (resets offset to 0) ───────────────────
	fmt.Println("\n── Step 1: Resetting Kafka consumer group offset ────────────")
	if err := resetConsumerGroup(ctx, *brokers, *group, *topic); err != nil {
		log.Fatal().Err(err).Msg("kafka offset reset failed")
	}
	log.Info().Str("group", *group).Msg("consumer group deleted — offset reset to 0")

	// ── Step 2: Truncate Postgres projection tables ───────────────────────────
	fmt.Println("\n── Step 2: Truncating projection tables ─────────────────────")
	if err := truncateTables(ctx, *dbURL, tableList); err != nil {
		log.Fatal().Err(err).Msg("postgres truncate failed")
	}
	log.Info().Strs("tables", tableList).Msg("projection tables truncated")

	// ── Step 3: Print restart instructions ───────────────────────────────────
	fmt.Println("\n── Step 3: Restart your consumer service ────────────────────")
	fmt.Printf("  docker compose restart projection-builder\n")
	fmt.Printf("  # or\n")
	fmt.Printf("  docker compose restart read-model-builder\n")
	fmt.Println()
	fmt.Println("  The service will replay all events from offset 0.")
	fmt.Println("  Watch progress:")
	fmt.Printf("  docker compose logs -f projection-builder\n")
	fmt.Println("────────────────────────────────────────────────────────────\n")

	log.Info().Msg("replay-projection complete — restart your consumer to rebuild")
}

// resetConsumerGroup deletes the consumer group so Kafka forgets its committed
// offset. On next start, the consumer reads from kafka.FirstOffset (0).
func resetConsumerGroup(ctx context.Context, brokers, group, topic string) error {
	client := &kafka.Client{
		Addr:    kafka.TCP(strings.Split(brokers, ",")...),
		Timeout: 10 * time.Second,
	}

	// Fetch current partitions so we know what offsets exist
	meta, err := client.Metadata(ctx, &kafka.MetadataRequest{
		Topics: []string{topic},
	})
	if err != nil {
		return fmt.Errorf("fetch metadata: %w", err)
	}

	if len(meta.Topics) == 0 {
		return fmt.Errorf("topic %q not found in Kafka", topic)
	}

	partitions := make([]int, 0, len(meta.Topics[0].Partitions))
	for _, p := range meta.Topics[0].Partitions {
		partitions = append(partitions, p.ID)
		log.Info().Str("topic", topic).Int("partition", p.ID).Msg("found partition")
	}

	// Delete the consumer group — this wipes all committed offsets
	resp, err := client.DeleteGroups(ctx, &kafka.DeleteGroupsRequest{
		Addr:   kafka.TCP(strings.Split(brokers, ",")...),
		Groups: []string{group},
	})
	if err != nil {
		return fmt.Errorf("delete group: %w", err)
	}

	for _, g := range resp.Groups {
		if g.Error != nil {
			// GroupIDNotFound is fine — group didn't exist yet
			if !strings.Contains(g.Error.Error(), "GroupIDNotFound") {
				return fmt.Errorf("delete group %q: %w", g.GroupID, g.Error)
			}
			log.Info().Str("group", g.GroupID).Msg("group did not exist — already at offset 0")
			return nil
		}
		log.Info().Str("group", g.GroupID).Msg("consumer group deleted")
	}

	return nil
}

// truncateTables truncates each projection table inside a single transaction.
// Uses CASCADE to handle any FK references.
func truncateTables(ctx context.Context, dbURL string, tables []string) error {
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		return fmt.Errorf("pgxpool connect: %w", err)
	}
	defer pool.Close()

	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	for _, table := range tables {
		// Whitelist check — only allow alphanumeric + underscore table names
		if !isSafeIdentifier(table) {
			return fmt.Errorf("unsafe table name: %q", table)
		}
		if _, err := tx.Exec(ctx, fmt.Sprintf("TRUNCATE TABLE %s CASCADE", table)); err != nil {
			return fmt.Errorf("truncate %q: %w", table, err)
		}
		log.Info().Str("table", table).Msg("truncated")
	}

	return tx.Commit(ctx)
}

func isSafeIdentifier(s string) bool {
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_') {
			return false
		}
	}
	return len(s) > 0
}

func splitTrim(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
