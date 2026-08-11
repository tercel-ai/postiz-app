import { describe, it, expect, vi } from 'vitest';
import { EngageRepository } from '../engage.repository';

// W7 regression: getOrgContextsForUnit's keyword branch must resolve the right
// subscribing orgs. The SQL `equals insensitive` pre-filter narrows by case; the
// in-code normalizeKeyword filter is the authoritative match (belt-and-braces for
// legacy non-canonical rows). Verify the in-code filter keeps only orgs whose
// keyword normalises to the unit key, regardless of case/whitespace.
function buildRepo(configFindMany: any) {
  const _config = { model: { engageConfig: { findMany: configFindMany } } } as any;
  // Only _config (arg 1) is exercised by getOrgContextsForUnit.
  return new EngageRepository(
    _config,
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any
  );
}

describe('EngageRepository.getOrgContextsForUnit (keyword)', () => {
  it('keeps orgs whose keyword normalises to the unit key, drops the rest', async () => {
    const findMany = vi.fn(async () => [
      { organizationId: 'o1', keywords: [{ enabled: true, keyword: 'AI' }], trackedAccounts: [] },        // "ai" ✓
      { organizationId: 'o2', keywords: [{ enabled: true, keyword: ' ai ' }], trackedAccounts: [] },      // legacy padded → "ai" ✓
      { organizationId: 'o3', keywords: [{ enabled: true, keyword: 'airplane' }], trackedAccounts: [] },  // "airplane" ✗ (SQL false-positive guard)
    ]);
    const repo = buildRepo(findMany);
    const res = await repo.getOrgContextsForUnit('reddit', 'keyword', 'ai');
    expect(res.map((c: any) => c.organizationId)).toEqual(['o1', 'o2']);
    // SQL pre-filter used case-insensitive equality on the unit key
    const where = findMany.mock.calls[0][0].where;
    expect(where.keywords.some.keyword).toEqual({ equals: 'ai', mode: 'insensitive' });
  });

  it('channel/tracked branches query the merged scan-target relation by scope', async () => {
    const findMany = vi.fn(async () => [
      { organizationId: 'o1', keywords: [], trackedAccounts: [] },
    ]);
    const repo = buildRepo(findMany);
    await repo.getOrgContextsForUnit('reddit', 'channel', 'webdev');
    const where = findMany.mock.calls[0][0].where;
    // Both scopes resolve against engageTrackedAccount now; the scan key lands
    // in `username` whichever scope the unit is.
    expect(where.trackedAccounts.some).toMatchObject({
      enabled: true,
      platform: 'reddit',
      username: { equals: 'webdev', mode: 'insensitive' },
    });
  });

  it('returns no subscribers when the scanType contradicts the platform scope', async () => {
    const findMany = vi.fn(async () => [
      { organizationId: 'o1', keywords: [], trackedAccounts: [] },
    ]);
    const repo = buildRepo(findMany);

    // reddit is channel scope and x is author scope: these two units could be
    // created before the merge and no scanner could serve either.
    expect(await repo.getOrgContextsForUnit('reddit', 'tracked', 'spez')).toEqual([]);
    expect(await repo.getOrgContextsForUnit('x', 'channel', 'somesub')).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
