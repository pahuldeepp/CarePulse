import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('v1');

  // S11: Stripe subscriptions + usage metering goes here
  // S11: failed payment webhook handler goes here

  await app.listen(process.env.PORT ?? 3002);
  console.log(JSON.stringify({ msg: 'billing-service listening', port: 3002 }));
}

bootstrap();
