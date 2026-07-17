import { describe, it, expect, vi } from 'vitest';
import { OperationPlanController } from '../operation-plan.controller';

describe('OperationPlanController.getOverview', () => {
  it('passes the authenticated org id and the route param through to the service', async () => {
    const operationPlanService = {
      getOverview: vi.fn().mockResolvedValue({ plan: {}, posts: [], engageStats: {} }),
    };
    const controller = new OperationPlanController(operationPlanService as any);

    await controller.getOverview({ id: 'org-1' } as any, 'plan-1');

    expect(operationPlanService.getOverview).toHaveBeenCalledWith('org-1', 'plan-1');
  });
});

describe('OperationPlanController.create', () => {
  const body = {
    taskId: 'task-1',
    startAt: '2026-08-01T00:00:00.000Z',
    endAt: '2026-08-02T00:00:00.000Z',
    platforms: ['x'],
  };

  it('uses the route project and authenticated organization; no dryRun query = real run', async () => {
    const operationPlanService = { create: vi.fn().mockResolvedValue({ id: 'plan-1' }) };
    const controller = new OperationPlanController(operationPlanService as any);

    await controller.create({ id: 'org-1' } as any, 'project-1', body);

    expect(operationPlanService.create).toHaveBeenCalledWith('org-1', 'project-1', body, {
      dryRun: false,
    });
  });

  it('passes dryRun=true when the query flag is "true" or "1"', async () => {
    const operationPlanService = { create: vi.fn().mockResolvedValue({ dryRun: true }) };
    const controller = new OperationPlanController(operationPlanService as any);

    await controller.create({ id: 'org-1' } as any, 'project-1', body, 'true');
    await controller.create({ id: 'org-1' } as any, 'project-1', body, '1');

    expect(operationPlanService.create).toHaveBeenNthCalledWith(1, 'org-1', 'project-1', body, {
      dryRun: true,
    });
    expect(operationPlanService.create).toHaveBeenNthCalledWith(2, 'org-1', 'project-1', body, {
      dryRun: true,
    });
  });
});
