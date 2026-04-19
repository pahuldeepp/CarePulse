import { Kafka } from 'kafkajs';
import { Pool } from 'pg';

const kafka = new Kafka({
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
  clientId: 'replay-projection-script',
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://carepack:carepack@localhost:5433/carepack',
});

async function replay() {
  const admin = kafka.admin();
  await admin.connect();

  // Reset projection-builder consumer group to earliest on both patient topics
  await admin.resetOffsets({
    groupId: 'projection-builder',
    topic: 'patient.created',
    earliest: true,
  });
  await admin.resetOffsets({
    groupId: 'projection-builder',
    topic: 'patient.updated',
    earliest: true,
  });

  await admin.disconnect();
  console.log('✓ Kafka offsets reset to earliest for projection-builder');

  // Truncate the read model — projection-builder will rebuild it from the log
  await pool.query('TRUNCATE TABLE patient_dashboard_projection');
  await pool.end();
  console.log('✓ patient_dashboard_projection truncated');

  console.log('\nRestart projection-builder to rebuild from offset 0.');
}

replay().catch((err) => {
  console.error('replay failed:', err);
  process.exit(1);
});
