import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('v1');

  // S11: Stripe subscriptions + usage metering goes here
  // S11: failed payment webhook handler goes here

  const port = Number(process.env.PORT ?? 3002);
  await app.listen(port);
  console.log(JSON.stringify({ msg: 'billing-service listening', port }));
}

bootstrap();
