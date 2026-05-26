import 'source-map-support/register';
import { setupHttpDispatcher } from '@gitroom/helpers/proxy/setup-dispatcher';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@gitroom/orchestrator/app.module';
import * as dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

// Reddit (REDDIT_PROXY) is routed separately from general traffic (HTTPS_PROXY)
// because Reddit's API IP-blocks data-center / commercial-VPN exit IPs.
setupHttpDispatcher();

async function bootstrap() {
  // some comment again
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
}

bootstrap();
