// context.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { AiUsageInfo } from '@gitroom/nestjs-libraries/openai/openai.service';

type Ctx = {
  requestId: string;
  auth: any; // replace with your org type if you have it, e.g. Organization
  usages?: AiUsageInfo[];
};

const als = new AsyncLocalStorage<Ctx>();

export function runWithContext<T>(ctx: Ctx, fn: () => Promise<T> | T) {
  return als.run(ctx, fn);
}

export function getContext(): Ctx | undefined {
  return als.getStore();
}

export function getAuth<T = any>(): T | undefined {
  return als.getStore()?.auth as T | undefined;
}

export function getRequestId(): string | undefined {
  return als.getStore()?.requestId;
}

export function collectUsage(usage: AiUsageInfo): void {
  const store = als.getStore();
  if (store?.usages) {
    store.usages.push(usage);
  }
}

export function getCollectedUsages(): AiUsageInfo[] {
  return als.getStore()?.usages ?? [];
}
