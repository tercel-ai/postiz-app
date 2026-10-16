import { afterEach, describe, it, expect, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  OperationPlanController,
  CreateOperationPlanDto,
} from '../operation-plan.controller';
import { SavePlanExecutionDto } from '@gitroom/nestjs-libraries/extension/plan-execution.dto';

afterEach(() => vi.unstubAllEnvs());
const routes = { x: { POST: { integrationId: 'account' } } };
describe('compatible operation plan account endpoints', () => {
  it('keeps create arguments and dryRun query while forwarding the new optional account map', async () => {
    const create = vi.fn();
    const controller = new OperationPlanController({ create } as any);
    const body = {
      taskId: 'task',
      startAt: '2030-01-01T00:00:00Z',
      endAt: '2030-01-02T00:00:00Z',
      platforms: ['x'],
      executionRoutes: routes,
    };
    await controller.create({ id: 'org' } as any, 'project', body, 'true');
    expect(create).toHaveBeenCalledWith('org', 'project', body, {
      dryRun: true,
    });
    expect(
      await validate(plainToInstance(CreateOperationPlanDto, body))
    ).toEqual([]);
  });
  it('forwards tenant, current user, persisted project scope and revisions to route saving', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    const save = vi.fn().mockResolvedValue({ executionRevision: 1 });
    const controller = new OperationPlanController({} as any, { save } as any);
    const body = {
      expectedRevision: 0,
      executionRoutes: routes,
      drafts: [],
      requestId: 'save',
    };
    expect(
      await controller.saveExecutionRoutes(
        { id: 'org' } as any,
        { id: 'user' } as any,
        'project',
        'plan',
        body
      )
    ).toEqual({ executionRevision: 1 });
    expect(save).toHaveBeenCalledWith('org', 'user', 'project', 'plan', body);
  });
  it('blocks route saving while the compatibility feature is disabled', () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    const controller = new OperationPlanController(
      {} as any,
      { save: vi.fn() } as any
    );
    expect(() =>
      controller.saveExecutionRoutes(
        { id: 'org' } as any,
        { id: 'user' } as any,
        'project',
        'plan',
        { expectedRevision: 0, executionRoutes: {}, drafts: [] }
      )
    ).toThrow('PROJECT_ACCOUNT_BINDINGS_DISABLED');
  });
  it('validates nested versions and forbids client-selected terminals or snapshots', async () => {
    for (const value of [
      { expectedRevision: -1, executionRoutes: routes, drafts: [] },
      {
        expectedRevision: 0,
        executionRoutes: {
          x: { POST: { integrationId: 'account', terminalId: 'node' } },
        },
        drafts: [],
      },
      {
        expectedRevision: 0,
        executionRoutes: routes,
        drafts: [{ id: 'post', expectedRouteRevision: -1 }],
      },
    ])
      expect(
        (await validate(plainToInstance(SavePlanExecutionDto, value))).length
      ).toBeGreaterThan(0);
    expect(
      await validate(
        plainToInstance(SavePlanExecutionDto, {
          expectedRevision: 0,
          executionRoutes: routes,
          drafts: [{ id: 'post', expectedRouteRevision: 1 }],
        })
      )
    ).toEqual([]);
  });
});
