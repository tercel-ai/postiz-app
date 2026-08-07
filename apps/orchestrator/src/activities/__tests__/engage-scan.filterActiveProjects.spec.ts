import { describe, it, expect, vi } from 'vitest';
import { EngageScanActivity } from '../engage-scan.activity';

/**
 * _filterActiveProjects is the null-projectId branch point for the engage
 * scan fan-out: legacy (pre-project) EngageConfig rows carry projectId=null
 * and must never be asked about via aisee-core, since there is no project to
 * ask about. The existing orchestration spec constructs EngageScanActivity
 * without a ProjectValidationService (11 positional args, none of them it),
 * so that suite never exercises this method's real branches — this file
 * closes that gap directly.
 */
function createActivity(projectValidation?: { isProjectActive: ReturnType<typeof vi.fn> }) {
  return new EngageScanActivity(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any,
    {} as any, {} as any, {} as any,
    projectValidation as any
  );
}

function filterActiveProjects(activity: EngageScanActivity, contexts: unknown[]) {
  return (activity as any)._filterActiveProjects(contexts);
}

describe('EngageScanActivity._filterActiveProjects', () => {
  it('passes a null-projectId (legacy) context through without calling aisee-core', async () => {
    const isProjectActive = vi.fn();
    const activity = createActivity({ isProjectActive });
    const contexts = [{ organizationId: 'org-1', projectId: null }];

    const result = await filterActiveProjects(activity, contexts);

    expect(result).toEqual(contexts);
    expect(isProjectActive).not.toHaveBeenCalled();
  });

  it('drops a context whose project is deactivated', async () => {
    const isProjectActive = vi.fn().mockResolvedValue(false);
    const activity = createActivity({ isProjectActive });
    const contexts = [{ organizationId: 'org-1', projectId: 'proj-1' }];

    const result = await filterActiveProjects(activity, contexts);

    expect(result).toEqual([]);
    expect(isProjectActive).toHaveBeenCalledWith('org-1', 'proj-1');
  });

  it('keeps a context whose project is active', async () => {
    const isProjectActive = vi.fn().mockResolvedValue(true);
    const activity = createActivity({ isProjectActive });
    const contexts = [{ organizationId: 'org-1', projectId: 'proj-1' }];

    const result = await filterActiveProjects(activity, contexts);

    expect(result).toEqual(contexts);
  });

  it('handles a mix of legacy (null), active, and deactivated contexts in one call', async () => {
    const isProjectActive = vi.fn((_org: string, projectId: string) =>
      Promise.resolve(projectId === 'proj-active')
    );
    const activity = createActivity({ isProjectActive });
    const legacy = { organizationId: 'org-1', projectId: null };
    const active = { organizationId: 'org-1', projectId: 'proj-active' };
    const inactive = { organizationId: 'org-1', projectId: 'proj-inactive' };

    const result = await filterActiveProjects(activity, [legacy, active, inactive]);

    expect(result).toEqual([legacy, active]);
    expect(isProjectActive).toHaveBeenCalledTimes(2);
  });

  it('passes every context through unfiltered when ProjectValidationService is not wired', async () => {
    const activity = createActivity(undefined);
    const contexts = [
      { organizationId: 'org-1', projectId: null },
      { organizationId: 'org-1', projectId: 'proj-1' },
    ];

    const result = await filterActiveProjects(activity, contexts);

    expect(result).toEqual(contexts);
  });
});
