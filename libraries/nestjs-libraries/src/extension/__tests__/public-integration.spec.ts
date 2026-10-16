import { describe, expect, it } from 'vitest';
import { publicIntegration } from '../public-integration';

describe('public integration DTO', () => {
  it('keeps public account fields and excludes credentials and unknown future fields', () => {
    const result = publicIntegration({
      id: 'account',
      name: 'Alice',
      profile: 'alice',
      providerIdentifier: 'x',
      token: 'secret',
      refreshToken: 'refresh',
      customInstanceDetails: 'private',
      metadata: { credential: 'private' },
      futureSecret: 'private',
      disabled: false,
    });
    expect(result).toEqual({
      id: 'account',
      name: 'Alice',
      profile: 'alice',
      providerIdentifier: 'x',
      disabled: false,
    });
  });
});
