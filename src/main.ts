import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { config } from 'dotenv';
import { resolve } from 'path';
import { AppModule } from './app.module';
import { getEnvNumber } from './common/env';
import { runStartupMigrations } from './common/run-startup-migrations';

config({ path: resolve(process.cwd(), '.env') });

async function bootstrap() {
  // Complete schema migrations before module-init background jobs query the database.
  await runStartupMigrations();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  const bodyLimitMb = getEnvNumber('BODY_SIZE_LIMIT_MB', 50);

  app.useBodyParser('json', { limit: `${bodyLimitMb}mb` });
  app.useBodyParser('urlencoded', { limit: `${bodyLimitMb}mb`, extended: true });

  app.setGlobalPrefix('v1/api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.enableCors();

  const port = getEnvNumber('PORT', 6001);

  await app.listen(port, '0.0.0.0');

  console.log(`Server running on ${port}`);

}
void bootstrap();
