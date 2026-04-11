import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('v1');

  // S2: Prisma middleware for PHI audit log goes here
  // S2: RLS SET LOCAL helper goes here

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(JSON.stringify({ msg: 'patient-service listening', port }));
}

bootstrap();
