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

  // S11: Stripe subscriptions + usage metering goes here
  // S11: failed payment webhook handler goes here

  const port = Number(process.env.PORT ?? 3002);
  await app.listen(port);
  logger.info({ msg: 'billing-service listening', port });
}

bootstrap();
