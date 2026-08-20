import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SchedulePostsDto } from '../schedule-posts.dto';

const check = (body: any) =>
  validateSync(plainToInstance(SchedulePostsDto, body)).map((e) => e.property);

// This route now names its batch ONE way: explicit post ids. It used to also
// accept a `planId` ("activate this plan"), which made a project-scoped action
// travel in an org-scoped body — no projectId meant the global ProjectAuthGuard
// never fired, so nothing checked the plan belonged to a project the caller was
// acting on. That form moved to POST /projects/:projectId/automation/publishing.
describe('SchedulePostsDto validation', () => {
  it('accepts a batch of ids', () =>
    expect(check({ posts: [{ id: 'p1' }] })).toEqual([]));

  it('accepts per-post send path and date', () =>
    expect(
      check({
        posts: [{ id: 'p1', publishMethod: 'api', date: '2026-08-20T10:00:00.000Z' }],
      })
    ).toEqual([]));

  it('rejects an empty body', () => expect(check({})).toEqual(['posts']));

  it('rejects an empty posts array', () =>
    expect(check({ posts: [] })).toEqual(['posts']));

  it('rejects a post with no id', () =>
    expect(check({ posts: [{ publishMethod: 'api' }] })).toEqual(['posts']));

  it('rejects a bad per-post publishMethod', () =>
    expect(check({ posts: [{ id: 'p1', publishMethod: 'carrier-pigeon' }] })).toEqual([
      'posts',
    ]));

  // Pinned so the plan form cannot quietly come back on this route: a body that
  // names a plan is now just an unrecognised body missing its required `posts`.
  it('no longer accepts a planId batch', () => {
    expect(check({ planId: 'plan-1' })).toEqual(['posts']);
    expect(check({ planId: 'plan-1', platforms: ['x'] })).toEqual(['posts']);
  });
});
