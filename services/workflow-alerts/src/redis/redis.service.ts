import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  onModuleInit() {
    this.client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });

    this.client.on('connect', () => this.logger.log('redis_connected'));
    this.client.on('error', (err) => this.logger.error(`redis_error ${err.message}`));
  }

  async onModuleDestroy() {
    await this.client?.quit();
  }

  /**
   * Publish a message to a Redis pub/sub channel.
   * Used to push alert events to the GraphQL gateway's subscription resolver.
   * Channel naming: alerts:{tenantId} — scoped per tenant to prevent PHI cross-leak.
   */
  async publish(channel: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.client.publish(channel, JSON.stringify(payload));
      this.logger.debug(`redis_published channel=${channel}`);
    } catch (err) {
      // Redis publish failure must never block the Postgres write or DynamoDB write.
      // The alert is already persisted — the dashboard just won't get the real-time push.
      this.logger.error(`redis_publish_failed channel=${channel} error=${err}`);
    }
  }
}
