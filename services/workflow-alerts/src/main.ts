import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { createLogger, format, transports } from 'winston';
import { AppModule } from './app.module';

const logger = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('v1');

  // Kafka microservice — consumes domain.risk.scored published by risk-engine.
  // Hybrid app: HTTP (REST) + Kafka consumer running in the same process.
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: [(process.env.KAFKA_BOOTSTRAP ?? 'localhost:9092')],
      },
      consumer: {
        groupId: 'workflow-alerts',
      },
    },
  });

  await app.startAllMicroservices();

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  logger.info({ msg: 'workflow-alerts listening', port: Number(port) });
}

bootstrap();
