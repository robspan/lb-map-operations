import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { NextFunction, Request, Response } from 'express';
import { AppModule } from './app/app.module';
import { OpsConfigService } from './app/config/ops-config.service';
import { MetricsService } from './app/observability/metrics.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();

  const config = app.get(OpsConfigService);
  const metrics = app.get(MetricsService);
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (
      request.path.startsWith('/api') &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !isAllowedUnsafeRequest(request)
    ) {
      response.status(403).json({
        code: 'FORBIDDEN_ORIGIN',
        message: 'request origin is not allowed',
      });
      return;
    }
    next();
  });
  const publicDir = resolve(config.uiPublicDir || join(__dirname, 'public'));
  if (existsSync(publicDir)) {
    app.useStaticAssets(publicDir, { index: false });
    const express = app.getHttpAdapter().getInstance();
    express.use((request: Request, response: Response, next: NextFunction) => {
      if (
        request.path.startsWith('/api') ||
        request.path === '/healthz' ||
        request.path === '/metrics'
      ) {
        next();
        return;
      }
      response.sendFile(join(publicDir, 'index.html'));
    });
  }

  createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    response.end(metrics.render());
  }).listen(config.metricsPort, '0.0.0.0');

  await app.listen(config.port, '0.0.0.0');
  Logger.log(`LB-MAP operations API listening on port ${config.port}`);
  Logger.log(`LB-MAP operations metrics listening on port ${config.metricsPort}`);
}

bootstrap();

function isAllowedUnsafeRequest(request: Request): boolean {
  const secFetchSite = headerValue(request.headers['sec-fetch-site']).toLowerCase();
  if (secFetchSite === 'same-origin' || secFetchSite === 'same-site') {
    return true;
  }
  if (secFetchSite) {
    return false;
  }
  const origin = headerValue(request.headers.origin);
  const host = headerValue(request.headers.host);
  if (!origin || !host) {
    return process.env.NODE_ENV !== 'production';
  }
  try {
    const parsed = new URL(origin);
    const proto = headerValue(request.headers['x-forwarded-proto']) || request.protocol;
    return parsed.host === host && parsed.protocol === `${proto}:`;
  } catch {
    return false;
  }
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] || '';
  }
  return value || '';
}
