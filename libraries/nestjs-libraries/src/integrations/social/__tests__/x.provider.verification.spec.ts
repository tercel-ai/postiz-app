import { beforeEach, describe, expect, it, vi } from 'vitest';
import { XProvider } from '../x.provider';

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@prisma/client', () => ({
  PrismaClient: class {
    integration = { findUnique: mocks.findUnique, update: mocks.update };
  },
}));
vi.mock('twitter-api-v2', () => ({
  TwitterApi: class {
    v2 = { me: mocks.me };
    loginWithOAuth2 = vi.fn().mockResolvedValue({
      accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600,
    });
  },
}));
vi.mock('@gitroom/nestjs-libraries/database/prisma/api-usage/api-usage.service', () => ({
  recordApiUsage: vi.fn(),
  isXAppOwner: vi.fn(),
  X_USAGE: { USER_READ: 'user_read' },
}));

describe('X account verification metadata', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ['blue', false, true],
    ['business', false, true],
    ['government', false, true],
    ['none', false, false],
    [undefined, true, true],
  ])('returns the raw OAuth verification type %s alongside the existing boolean', async (verifiedType, legacyVerified, verified) => {
    mocks.me.mockResolvedValue({
      data: { id: '123', name: 'Alice', username: 'alice', verified_type: verifiedType, verified: legacyVerified },
    });

    const result = await new XProvider().authenticate({ code: 'test', codeVerifier: 'test' });

    expect(result).toMatchObject({
      additionalSettings: [{ title: 'Verified', value: verified, verified_type: verifiedType ?? null }],
    });
  });

  it('stores a changed verification type even when the boolean is unchanged', async () => {
    const integration = { id: 'account' };
    const stat = { title: 'account:followers', value: 50 };
    mocks.findUnique.mockResolvedValue({
      additionalSettings: JSON.stringify([{ title: 'Verified', value: true, verified_type: 'business' }, stat]),
    });

    await (new XProvider() as any)._syncVerifiedStatus(integration, true, 'blue');

    expect(mocks.update).toHaveBeenCalledTimes(1);
    const { data } = mocks.update.mock.calls[0][0];
    expect(JSON.parse(data.additionalSettings)).toMatchObject([
      { title: 'Verified', value: true, verified_type: 'blue' },
      stat,
    ]);
  });

  it('skips writes when both verification values match', async () => {
    mocks.findUnique.mockResolvedValue({
      additionalSettings: JSON.stringify([{ title: 'Verified', value: true, verified_type: 'blue' }]),
    });

    await (new XProvider() as any)._syncVerifiedStatus({ id: 'account' }, true, 'blue');

    expect(mocks.update).not.toHaveBeenCalled();
  });
});
