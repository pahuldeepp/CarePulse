import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createLogger, format, transports } from 'winston';
import { AppModule } from './app.module';
import { provisionKafkaTopics } from './kafka/kafka-admin';

const logger = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

async function bootstrap() {
  // Provision Kafka topics with a 30s timeout to prevent indefinite startup hangs
  await Promise.race([
    provisionKafkaTopics(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Kafka topic provisioning timed out after 30s')), 30_000),
    ),
  ]);

  const app = await NestFactory.create(AppModule, { logger: false });

  // Enable Nest shutdown hooks so PrismaService.onModuleDestroy fires on SIGTERM
  app.enableShutdownHooks();
  app.setGlobalPrefix('v1');

  // S2: Prisma middleware for PHI audit log goes here
  // S2: RLS SET LOCAL helper goes here

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.info({ msg: 'patient-service listening', port: Number(port) });
}

bootstrap();
