import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import { config } from 'dotenv';
import helmet from 'helmet';
import { resolve } from 'path';
import { AppModule } from './app.module';
import { getEnvNumber, getEnvValue } from './common/env';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { runStartupMigrations } from './common/run-startup-migrations';

config({ path: resolve(process.cwd(), '.env') });

/** CORS_ORIGINS=https://app.agentmetra.lk,https://admin.agentmetra.lk (APP_PUBLIC_URL is always allowed). */
function allowedOrigins(): string[] | true {
  const list = [getEnvValue('CORS_ORIGINS', ''), getEnvValue('APP_PUBLIC_URL', '')]
    .join(',')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (!list.length || list.includes('*')) return true;
  if (process.env.NODE_ENV !== 'production') list.push('http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173');
  return list;
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  // Complete schema migrations before module-init background jobs query the database.
  await runStartupMigrations();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // Behind Nginx / Cloudflare: real client IP for rate limits (TRUST_PROXY=1 = one proxy hop).
  app.set('trust proxy', getEnvNumber('TRUST_PROXY', 1));
  app.disable('x-powered-by');

  app.use(
    helmet({
      // API only – pages (Swagger) are not served; media files are opened from the web app.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );
  app.use(compression({ threshold: 1024 }));

  const bodyLimitMb = getEnvNumber('BODY_SIZE_LIMIT_MB', 25);
  app.useBodyParser('json', { limit: `${bodyLimitMb}mb` });
  app.useBodyParser('urlencoded', { limit: `${bodyLimitMb}mb`, extended: true });

  app.setGlobalPrefix('v1/api');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const origins = allowedOrigins();
  app.enableCors({
    origin: origins,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    maxAge: 600,
  });
  if (origins === true) logger.warn('CORS allows every origin. Set CORS_ORIGINS / APP_PUBLIC_URL in production.');

  app.enableShutdownHooks();
  const port = getEnvNumber('PORT', 3001);
  await app.listen(port, '0.0.0.0');
  logger.log(`API running on port ${port}`);
}
void bootstrap();
