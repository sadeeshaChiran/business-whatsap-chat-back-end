import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { config } from 'dotenv';
import { resolve } from 'path';
import { AppModule } from './app.module';
import { getEnvNumber } from './common/env';
import { runStartupMigrations } from './common/run-startup-migrations';
import { json, urlencoded } from 'express';

config({ path: resolve(process.cwd(), '.env') });

async function bootstrap() {
  await runStartupMigrations();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const bodyLimitMb = getEnvNumber('BODY_SIZE_LIMIT_MB', 50);
  app.useBodyParser('json', { limit: `${bodyLimitMb}mb` });
  app.useBodyParser('urlencoded', { limit: `${bodyLimitMb}mb`, extended: true });
  const globalPrefix = 'v1/api';
  app.setGlobalPrefix(globalPrefix);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Business Health Scanner API')
    .setDescription('API documentation for Business Health Scanner backend')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter JWT token',
      },
      'bearer',
    )
    .addSecurityRequirements('bearer')
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(`${globalPrefix}/swagger`, app, swaggerDocument);
  app.enableCors();
  await app.listen(getEnvNumber('PORT', 3000));
}
void bootstrap();
