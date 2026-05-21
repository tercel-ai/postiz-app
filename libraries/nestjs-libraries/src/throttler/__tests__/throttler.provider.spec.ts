import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerBehindProxyGuard } from '../throttler.provider';

const THROTTLER_LIMIT = 'THROTTLER:LIMIT';

// Build a minimal ExecutionContext-like fake.
function makeContext(opts: {
  url: string;
  handler?: object;
  classRef?: object;
}): ExecutionContext {
  const handler = opts.handler ?? function generateDraft() {};
  const classRef = opts.classRef ?? class EngageController {};
  return {
    switchToHttp: () => ({ getRequest: () => ({ url: opts.url, org: { id: 'org-1' }, user: { id: 'user-1' } }) }),
    getHandler: () => handler,
    getClass: () => classRef,
  } as unknown as ExecutionContext;
}

function makeGuard(throttleMetadataByHandler: Map<object, unknown>) {
  // Stub the parent canActivate so we can detect when it's invoked.
  const guard = new ThrottlerBehindProxyGuard(
    {} as any, // options
    {} as any, // storageService
    new Reflector(),
  );
  const superCanActivate = vi.fn().mockResolvedValue(true);
  // Replace super.canActivate by overriding the prototype chain on this instance.
  (guard as any).__proto__.__proto__.canActivate = superCanActivate;
  // Mock the reflector to return the per-handler metadata.
  vi.spyOn(guard['reflector'], 'getAllAndOverride').mockImplementation(
    ((...args: unknown[]) => {
      const key = args[0] as string;
      const targets = (args[1] as object[]) ?? [];
      if (key !== THROTTLER_LIMIT) return undefined;
      for (const t of targets) {
        if (throttleMetadataByHandler.has(t)) return throttleMetadataByHandler.get(t);
      }
      return undefined;
    }) as never
  );
  return { guard, superCanActivate };
}

describe('ThrottlerBehindProxyGuard — F-04 fix #1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('honors @Throttle metadata on a non-public route (was: silently bypassed)', async () => {
    const handler = function generateDraft() {};
    const meta = new Map<object, unknown>([[handler, { default: { limit: 20, ttl: 3_600_000 } }]]);
    const { guard, superCanActivate } = makeGuard(meta);

    const ctx = makeContext({ url: '/engage/opportunities/abc/draft', handler });
    const result = await guard.canActivate(ctx);

    expect(superCanActivate).toHaveBeenCalledOnce();
    expect(result).toBe(true);
  });

  it('still allows routes WITHOUT @Throttle metadata (no rate limiting)', async () => {
    const { guard, superCanActivate } = makeGuard(new Map());

    const ctx = makeContext({ url: '/engage/keywords' });
    const result = await guard.canActivate(ctx);

    expect(superCanActivate).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('continues to throttle the public-v1 paths regardless of @Throttle metadata', async () => {
    const { guard, superCanActivate } = makeGuard(new Map());

    const ctx = makeContext({ url: '/public/v1/posts' });
    await guard.canActivate(ctx);

    expect(superCanActivate).toHaveBeenCalledOnce();
  });
});
