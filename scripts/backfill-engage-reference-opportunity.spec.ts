import { describe, it, expect } from 'vitest';
import { parseArgs } from './backfill-engage-reference-opportunity';

describe('parseArgs', () => {
  it('defaults to dry-run with no org filter', () => {
    expect(parseArgs([])).toEqual({ orgId: null, dryRun: true });
  });

  it('parses --org', () => {
    expect(parseArgs(['--org', 'org_123'])).toEqual({
      orgId: 'org_123',
      dryRun: true,
    });
  });

  it('parses --execute', () => {
    expect(parseArgs(['--execute'])).toEqual({ orgId: null, dryRun: false });
  });

  it('parses --org together with --execute, in either order', () => {
    expect(parseArgs(['--org', 'org_1', '--execute'])).toEqual({
      orgId: 'org_1',
      dryRun: false,
    });
    expect(parseArgs(['--execute', '--org', 'org_1'])).toEqual({
      orgId: 'org_1',
      dryRun: false,
    });
  });

  it('a later --dry-run overrides an earlier --execute', () => {
    expect(parseArgs(['--execute', '--dry-run'])).toEqual({
      orgId: null,
      dryRun: true,
    });
  });
});
