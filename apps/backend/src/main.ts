import { initializeSentry } from '@gitroom/nestjs-libraries/sentry/initialize.sentry';
import { setupHttpDispatcher } from '@gitroom/helpers/proxy/setup-dispatcher';
initializeSentry('backend', true);

// Reddit (REDDIT_PROXY) is routed separately from general traffic (HTTPS_PROXY)
// because Reddit's API IP-blocks data-center / commercial-VPN exit IPs.
setupHttpDispatcher();

import { loadSwagger } from '@gitroom/helpers/swagger/load.swagger';
import { json } from 'express';
import { Runtime } from '@temporalio/worker';
Runtime.install({ shutdownSignals: [] });

process.env.TZ = 'UTC';

import cookieParser from 'cookie-parser';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

import { SubscriptionExceptionFilter } from '@gitroom/backend/services/auth/permissions/subscription.exception';
import { HttpExceptionFilter } from '@gitroom/nestjs-libraries/services/exception.filter';
import { validationExceptionFactory } from '@gitroom/nestjs-libraries/services/validation.exception.factory';
import { ConfigurationChecker } from '@gitroom/helpers/configuration/configuration.checker';
import { startMcp } from '@gitroom/nestjs-libraries/chat/start.mcp';

async function start() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    cors: {
      ...(!process.env.NOT_SECURED ? { credentials: true } : {}),
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'Accept',
        'Accept-Language',
        'Cache-Control',
        'Pragma',
        'Expires',
        'If-None-Match',
        'If-Modified-Since',
        'X-Requested-With',
        'X-CSRF-Token',
        'X-XSRF-Token',
        'Sentry-Trace',
        'Baggage',
        'x-copilotkit-runtime-client-gql-version',
        'x-timezone',
        // Which extension build is calling. A service worker with host
        // permissions bypasses CORS, but the same transport is reachable from
        // page contexts that do not — and a header missing from this list fails
        // preflight, which would take out every call rather than just this one.
        'x-aisee-ext-version',
        ...(process.env.NOT_SECURED ? ['auth', 'showorg', 'impersonate'] : []),
      ],
      exposedHeaders: [
        'reload',
        'onboarding',
        'activate',
        'x-copilotkit-runtime-client-gql-version',
        // The oldest extension build this API still serves. Sent on every
        // response so a client learns the floor while it is still ABOVE it —
        // 426 only tells you once you have already stopped working.
        'x-aisee-ext-min-version',
        ...(process.env.NOT_SECURED ? ['auth', 'showorg', 'impersonate'] : []),
      ],
      origin: [
        process.env.FRONTEND_URL,
        'http://localhost:6274',
        'http://localhost:3001',
        'http://localhost:4200',
        ...(process.env.MAIN_URL ? [process.env.MAIN_URL] : []),
        ...(process.env.EXTRA_CORS_ORIGINS
          ? process.env.EXTRA_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
          : []),
      ],
    },
  });

  await startMcp(app);

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      exceptionFactory: validationExceptionFactory,
    })
  );

  app.use('/copilot/*', (req: any, res: any, next: any) => {
    json({ limit: '50mb' })(req, res, next);
  });

  // The extension scan loop posts a batch of scraped posts per unit, and those
  // bodies are full-length: Reddit selftext, a dev.to article fetched from
  // /articles/{id} (capped at 10k chars each), a Quora answer read off its own
  // page. A page of 30 such posts clears the default 100kb limit easily (→ 413),
  // while staying an order of magnitude under the ceiling set here.
  app.use('/engage/scan-tasks/ingest', (req: any, res: any, next: any) => {
    json({ limit: '5mb' })(req, res, next);
  });

  app.use(cookieParser());
  app.useGlobalFilters(new SubscriptionExceptionFilter());
  app.useGlobalFilters(new HttpExceptionFilter());

  loadSwagger(app);

  const port = process.env.PORT || 3000;

  try {
    await app.listen(port);

    checkConfiguration(); // Do this last, so that users will see obvious issues at the end of the startup log without having to scroll up.

    Logger.log(`🚀 Backend is running on: http://localhost:${port}`);
  } catch (e) {
    Logger.error(`Backend failed to start on port ${port}`, e);
  }
}

function checkConfiguration() {
  const checker = new ConfigurationChecker();
  checker.readEnvFromProcess();
  checker.check();

  if (checker.hasIssues()) {
    for (const issue of checker.getIssues()) {
      Logger.warn(issue, 'Configuration issue');
    }

    Logger.warn('Configuration issues found: ' + checker.getIssuesCount());
  } else {
    Logger.log('Configuration check completed without any issues');
  }
}

start();
