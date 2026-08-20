import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AutomationController } from '../automation.controller';
import { PostsController } from '../posts.controller';
import { SchedulePostsDto } from '@gitroom/nestjs-libraries/dtos/posts/schedule-posts.dto';

// ProjectAuthGuard is a GLOBAL guard that only activates on a request carrying a
// projectId — as a route param, query param, or body field. A route without one
// is therefore authorized by org membership alone, which is how the endpoints
// this controller replaces let an org member read and activate a SIBLING
// project's plan, and queue posts for a project that had been deactivated.
//
// These are structural tests: they assert the shape that makes the guard fire,
// because losing that shape silently reopens the hole with no failing behaviour
// anywhere else to catch it.
describe('AutomationController — every route is project-scoped', () => {
  it('mounts the controller under a path that names the project', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AutomationController)).toBe(
      '/projects/:projectId/automation'
    );
  });

  it('exposes exactly the routes the Automation page needs', () => {
    const routes = Object.getOwnPropertyNames(AutomationController.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => ({
        name,
        path: Reflect.getMetadata(
          PATH_METADATA,
          (AutomationController.prototype as any)[name]
        ),
        method: Reflect.getMetadata(
          METHOD_METADATA,
          (AutomationController.prototype as any)[name]
        ),
      }))
      .filter((route) => route.method !== undefined);

    expect(routes).toEqual([
      { name: 'getOverview', path: '/', method: RequestMethod.GET },
      // The master switch gets its own route rather than a field on the two
      // feature endpoints: it governs both, and folding it into either would
      // make "suspend everything" a write that also has to carry that feature's
      // whole configuration.
      { name: 'saveEnabled', path: '/enabled', method: RequestMethod.POST },
      { name: 'savePublishing', path: '/publishing', method: RequestMethod.POST },
      { name: 'saveReplies', path: '/replies', method: RequestMethod.POST },
    ]);
  });

  it('reads through GET and writes through POST', () => {
    // Not cosmetic: the guard requires only project ACCESS on GET (a deactivated
    // project must stay readable so its owner can inspect and re-enable it) and
    // project ACTIVE on anything else.
    expect(
      Reflect.getMetadata(METHOD_METADATA, AutomationController.prototype.getOverview)
    ).toBe(RequestMethod.GET);
    for (const handler of [
      AutomationController.prototype.saveEnabled,
      AutomationController.prototype.savePublishing,
      AutomationController.prototype.saveReplies,
    ]) {
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    }
  });
});

// The plan form is GONE from /posts/schedule rather than patched with a
// projectId: its only caller was the Automation page, and that page now commits
// through the project-scoped route above, where the plan is resolved
// server-side and cannot be named by the client at all.
describe('SchedulePostsDto — the plan form no longer lives on /posts/schedule', () => {
  const validate = (body: Record<string, unknown>) =>
    validateSync(plainToInstance(SchedulePostsDto, body), {
      whitelist: true,
    }).map((e) => e.property);

  it('accepts a hand-picked posts batch', () => {
    expect(validate({ posts: [{ id: 'p1' }] })).toEqual([]);
  });

  it('rejects a plan-shaped body as simply missing its posts', () => {
    expect(validate({ planId: 'plan-1', projectId: 'proj-1' })).toEqual(['posts']);
  });

  it('ignores a stray planId even when one rides along on the body', async () => {
    // The global ValidationPipe does not whitelist, so an unknown property does
    // reach the DTO instance — what matters is that the handler no longer has a
    // branch that would act on it.
    const schedulePosts = vi.fn().mockResolvedValue({ scheduled: [], failed: [] });
    const schedulePlanPosts = vi.fn();
    const controller = new PostsController(
      { schedulePosts, schedulePlanPosts } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    await controller.schedulePosts({ id: 'org-1' } as any, {
      posts: [{ id: 'p1' }],
      planId: 'plan-1',
    } as any);

    expect(schedulePosts).toHaveBeenCalledWith('org-1', [{ id: 'p1' }]);
    expect(schedulePlanPosts).not.toHaveBeenCalled();
  });
});
