import { describe, expect, it, vi } from 'vitest';
import { hasIntegrationProfileConflict } from '../integration-profile.utils';

describe('hasIntegrationProfileConflict', () => {
  it.each([undefined, null, '', '  ', '@', 'u/'])('does not query for an empty profile: %s', async profile => {
    const findMany = vi.fn();
    expect(await hasIntegrationProfileConflict({ integration: { findMany } } as any,
      'org', 'x', profile)).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('scopes candidates by organization, exact provider and non-deleted social records', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'other', profile: ' u/ALICE ' }]);
    expect(await hasIntegrationProfileConflict({ integration: { findMany } } as any,
      'org', 'linkedin-page', '@alice', 'self')).toBe(true);
    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org', providerIdentifier: 'linkedin-page',
        type: 'social', deletedAt: null, id: { not: 'self' } },
      select: { id: true, profile: true },
    });
  });

  it('ignores self and empty profiles while retaining distinct punctuation', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'self', profile: 'Alice' }, { id: 'empty', profile: null },
      { id: 'different', profile: 'alice.other' },
    ]);
    expect(await hasIntegrationProfileConflict({ integration: { findMany } } as any,
      'org', 'x', '@alice', 'self')).toBe(false);
  });
});
