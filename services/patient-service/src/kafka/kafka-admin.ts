import { Kafka, ITopicConfig } from 'kafkajs';

const TOPICS: ITopicConfig[] = [
  {
    topic: 'patient.created',
    numPartitions: 6,       // parallelism — 1 partition per consumer instance
    replicationFactor: 3,   // 3 brokers → survive 2 failures
    configEntries: [
      { name: 'retention.ms', value: String(7 * 24 * 60 * 60 * 1000) }, // 7 days
      { name: 'cleanup.policy', value: 'delete' },
    ],
  },
  {
    topic: 'patient.updated',
    numPartitions: 6,
    replicationFactor: 3,
    configEntries: [
      { name: 'retention.ms', value: String(7 * 24 * 60 * 60 * 1000) },
      { name: 'cleanup.policy', value: 'delete' },
    ],
  },
  {
    topic: 'alert.triggered',
    numPartitions: 3,
    replicationFactor: 3,
    configEntries: [
      { name: 'retention.ms', value: String(30 * 24 * 60 * 60 * 1000) }, // 30 days
      { name: 'cleanup.policy', value: 'delete' },
    ],
  },
];

/**
 * Connects to Kafka as admin and creates any missing topics.
 * Safe to call on every startup — existing topics are skipped.
 */
export async function provisionKafkaTopics(): Promise<void> {
  const kafka = new Kafka({
    clientId: 'patient-service-admin',
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
  });

  const admin = kafka.admin();
  await admin.connect();

  try {
    const existing = await admin.listTopics();
    const toCreate = TOPICS.filter((t) => !existing.includes(t.topic));

    if (toCreate.length === 0) {
      console.log('[kafka-admin] All topics already exist — nothing to create');
      return;
    }

    await admin.createTopics({ topics: toCreate, waitForLeaders: true });
    console.log(
      '[kafka-admin] Created topics:',
      toCreate.map((t) => t.topic),
    );
  } finally {
    await admin.disconnect();
  }
}
