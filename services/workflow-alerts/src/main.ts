import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('v1');

  // S3: alert dedup (unique tenantId+dedupeKey) goes here
  // S3: OCC version column for optimistic locking goes here

  await app.listen(process.env.PORT ?? 3001);
  console.log(JSON.stringify({ msg: 'workflow-alerts listening', port: 3001 }));
}

bootstrap();
