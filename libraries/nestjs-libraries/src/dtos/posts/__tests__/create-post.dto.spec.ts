import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreatePostDto } from '../create.post.dto';
import { SchedulePostsDto } from '../schedule-posts.dto';
import { QueueStoredReplyDto } from '../../../extension/send-execution.dto';

const post = {
  integration: { id: 'account' }, providerIdentifier: 'x',
  expectedRouteRevision: 0, settings: { __type: 'x', who_can_reply_post: 'everyone' },
  value: [{ id: 'root', content: '<p>Saved original</p>', image: [] }],
};
const cases = [
  { name: 'full Post editor', check: (revision?: unknown) => validateSync(plainToInstance(CreatePostDto, {
    type: 'now', requestId: 'edit-original', projectId: 'project', shortLink: false,
    date: '2026-11-13T00:00:00.000Z', tags: [], inter: 0,
    posts: [{ ...post, expectedContentRevision: revision }],
  })) },
  { name: 'Post scheduling', check: (revision?: unknown) => validateSync(plainToInstance(SchedulePostsDto, {
    posts: [{ id: 'root', type: 'now', expectedRouteRevision: 0, expectedContentRevision: revision }],
  })) },
  { name: 'versioned saved Reply', check: (revision?: unknown) => validateSync(plainToInstance(QueueStoredReplyDto, {
    sentReplyId: '22222222-2222-4222-8222-222222222222', requestId: 'select-original',
    integrationId: 'account', expectedRouteRevision: 0, expectedContentRevision: revision,
  })) },
];

describe.each(cases)('$name content revision contract', ({ check }) => {
  it.each([0, 1])('accepts the stored nonnegative revision %s', revision => {
    expect(check(revision)).toEqual([]);
  });
  it.each([-1, 0.5, '0'])('rejects an invalid revision %j', revision => {
    expect(JSON.stringify(check(revision))).toContain('expectedContentRevision');
  });
  it('keeps revision metadata optional for existing callers', () => {
    expect(check()).toEqual([]);
  });
});
