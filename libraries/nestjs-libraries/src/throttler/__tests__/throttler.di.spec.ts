import { describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import { ThrottlerModule, ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerBehindProxyGuard } from '../throttler.provider';
import { createThrottlerStorage } from '../redis-throttler.storage';
import { RiskControlTickService } from '@gitroom/nestjs-libraries/risk-control/risk-control-tick.service';

/**
 * Nest must be able to CONSTRUCT the guard.
 *
 * The guard gained an explicit constructor so it could take the risk-control
 * recorder, which means it now names its own injection tokens instead of
 * inheriting the base class's metadata. Every other test in this folder builds
 * the guard with `new`, so none of them exercises that resolution — and the
 * failure mode is not a failing route, it is the whole application refusing to
 * boot. This is the only test that would catch a wrong token.
 */
describe('ThrottlerBehindProxyGuard — dependency injection', () => {
  it('resolves through the Nest container with the real ThrottlerModule', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ ttl: 3_600_000, limit: 30 }],
          storage: createThrottlerStorage(),
        }),
      ],
      providers: [
        ThrottlerBehindProxyGuard,
        // The real one needs Prisma; the guard only ever calls `record` on it,
        // and this test is about resolution, not behaviour.
        { provide: RiskControlTickService, useValue: { record: async (): Promise<void> => undefined } },
      ],
    }).compile();

    const guard = moduleRef.get(ThrottlerBehindProxyGuard);
    expect(guard).toBeInstanceOf(ThrottlerBehindProxyGuard);
    // Proves the base class actually received its dependencies rather than
    // being constructed with undefined and failing later, at the first request.
    expect(moduleRef.get<ThrottlerStorage>(ThrottlerStorage)).toBeDefined();
    await moduleRef.close();
  });

  it('still resolves when the recorder is absent, so telemetry stays optional', async () => {
    // A deployment that has not wired risk-control telemetry must still boot and
    // still throttle; @Optional() is what makes that true.
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({
          throttlers: [{ ttl: 3_600_000, limit: 30 }],
        }),
      ],
      providers: [ThrottlerBehindProxyGuard],
    }).compile();

    expect(moduleRef.get(ThrottlerBehindProxyGuard)).toBeInstanceOf(
      ThrottlerBehindProxyGuard
    );
    await moduleRef.close();
  });
});
