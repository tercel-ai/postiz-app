import { describe, it, expect, vi } from 'vitest';
import { OperationPlanService } from '../operation-plan.service';

// The single entry point a client needs before calling anything else
// plan-scoped. The contract that matters: it returns the id repo.getActivePlan
// resolves, verbatim — never invents a fallback, never 404s on "none yet".

function createService(getActivePlan: ReturnType<typeof vi.fn>) {
  return new OperationPlanService({ getActivePlan } as any);
}

describe('OperationPlanService.getActivePlanId', () => {
  it('returns the active plan\'s id', async () => {
    const getActivePlan = vi.fn().mockResolvedValue({ id: 'plan-1' });
    const service = createService(getActivePlan);

    const result = await service.getActivePlanId('org-1', 'proj-1');

    expect(result).toEqual({ id: 'plan-1' });
    expect(getActivePlan).toHaveBeenCalledWith(
      'org-1',
      'proj-1',
      expect.any(Date)
    );
  });

  it('returns { id: null } rather than throwing when the project has no active plan', async () => {
    const getActivePlan = vi.fn().mockResolvedValue(null);
    const service = createService(getActivePlan);

    // "No active plan" is a normal state for a project that hasn't generated
    // one yet — it must read as an empty answer, not an error a client has to
    // catch.
    await expect(service.getActivePlanId('org-1', 'proj-1')).resolves.toEqual({
      id: null,
    });
  });
});
