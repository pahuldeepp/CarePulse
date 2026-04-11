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
  // Ensure Kafka topics exist before accepting traffic
  await provisionKafkaTopics();

  const app = await NestFactory.create(AppModule, { logger: false });

  app.setGlobalPrefix('v1');

  // S2: Prisma middleware for PHI audit log goes here
  // S2: RLS SET LOCAL helper goes here

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.info({ msg: 'patient-service listening', port: Number(port) });
}

bootstrap();
