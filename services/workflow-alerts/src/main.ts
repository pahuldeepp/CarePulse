import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createLogger, format, transports } from 'winston';
import { AppModule } from './app.module';

const logger = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('v1');

  // S3: alert dedup (unique tenantId+dedupeKey) goes here
  // S3: OCC version column for optimistic locking goes here

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  logger.info({ msg: 'workflow-alerts listening', port: Number(port) });
}

bootstrap();
