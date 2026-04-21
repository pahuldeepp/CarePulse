import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createLogger, format, transports } from 'winston';
import { AppModule } from './app.module';

const logger = createLogger({
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: false,
    rawBody: true,
  });
  app.setGlobalPrefix('v1');

  const port = Number(process.env.PORT ?? 3002);
  await app.listen(port);
  logger.info({ msg: 'billing-service listening', port });
}

bootstrap();
