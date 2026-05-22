import 'source-map-support/register';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@gitroom/orchestrator/app.module';
import * as dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

const _orchestratorProxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (_orchestratorProxyUrl) {
  setGlobalDispatcher(new ProxyAgent(_orchestratorProxyUrl));
}

async function bootstrap() {
  // some comment again
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
}

bootstrap();
