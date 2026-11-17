import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SendCoordinatorService } from '../send-coordinator.service';

// The controlled pipeline records the terminal state itself, so it must also be
// the one to announce it. These cases pin the event/dedup-key shape to the
// legacy publish paths: same fact, same key, therefore never two messages.
function makeService(
  data: {
    post?: any;
    intent?: any;
    segments?: any[];
    reply?: any;
  } = {},
  notifications?: { notify: any }
) {
  const db: any = {
    sendExecution: {
      findFirst: vi.fn().mockResolvedValue({ sendIntentId: 'intent-1' }),
    },
    sendIntent: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          data.intent ?? { rootPostId: 'post-1', action: 'POST' }
        ),
    },
    post: {
      findFirst: vi.fn().mockResolvedValue(
        data.post ?? {
          id: 'post-1',
          state: 'PUBLISHED',
          removedAt: null,
          releaseURL: 'https://x.com/u/status/1',
          projectId: 'project-1',
          providerIdentifier: 'x',
          integration: { providerIdentifier: 'x' },
        }
      ),
    },
    sendSegment: {
      findMany: vi
        .fn()
        .mockResolvedValue(data.segments ?? [{ status: 'CONFIRMED' }]),
    },
    engageSentReply: {
      findUnique: vi.fn().mockResolvedValue(data.reply ?? null),
    },
  };
  const svc = new SendCoordinatorService(
    db,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    undefined,
    notifications as any
  );
  return { svc, db };
}

describe('SendCoordinatorService.notifySendOutcome', () => {
  beforeEach(() => vi.clearAllMocks());

  it('announces a confirmed post with the workflow’s key', async () => {
    const notify = vi.fn().mockResolvedValue(true);
    const { svc } = makeService({}, { notify });

    await svc.notifySendOutcome('org-1', 'exec-1');

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      organizationId: 'org-1',
      eventKey: 'post.published',
      dedupKey: 'post.published:post-1',
      data: {
        platform: 'X',
        post_id: 'post-1',
        project_id: 'project-1',
        external_url: 'https://x.com/u/status/1',
      },
    });
  });

  it('announces a failed post', async () => {
    const notify = vi.fn().mockResolvedValue(true);
    const { svc } = makeService(
      {
        post: {
          id: 'post-1',
          state: 'ERROR',
          removedAt: null,
          releaseURL: null,
          projectId: 'project-1',
          providerIdentifier: 'x',
          integration: { providerIdentifier: 'x' },
        },
      },
      { notify }
    );

    await svc.notifySendOutcome('org-1', 'exec-1');

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: 'post.publish_failed',
        dedupKey: 'post.publish_failed:post-1',
      })
    );
  });

  it('announces both facts for a half-published thread, keyed on the anchor', async () => {
    const notify = vi.fn().mockResolvedValue(true);
    const { svc } = makeService(
      {
        post: {
          id: 'anchor',
          state: 'PUBLISHED',
          removedAt: null,
          releaseURL: 'https://x.com/u/status/1',
          projectId: 'project-1',
          providerIdentifier: 'x',
          integration: { providerIdentifier: 'x' },
        },
        segments: [{ status: 'CONFIRMED' }, { status: 'NOT_SUBMITTED' }],
      },
      { notify }
    );

    await svc.notifySendOutcome('org-1', 'exec-1');

    expect(notify.mock.calls.map((call) => call[0].eventKey)).toEqual([
      'post.published',
      'post.publish_failed',
    ]);
    for (const call of notify.mock.calls) {
      expect(call[0].dedupKey).toMatch(/^post\.(published|publish_failed):anchor$/);
    }
  });

  it('announces a published reply on the engage channel, keyed per reply', async () => {
    const notify = vi.fn().mockResolvedValue(true);
    const { svc } = makeService(
      {
        intent: { rootPostId: 'reply-post-1', action: 'REPLY' },
        post: {
          id: 'reply-post-1',
          state: 'PUBLISHED',
          removedAt: null,
          releaseURL: 'https://x.com/u/status/2',
          projectId: 'project-1',
          providerIdentifier: 'x',
          integration: { providerIdentifier: 'x' },
        },
        reply: { id: 'reply-1' },
      },
      { notify }
    );

    await svc.notifySendOutcome('org-1', 'exec-1');

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: 'engage.replied',
        dedupKey: 'engage.replied:reply-1',
        channel: 'engage',
      })
    );
  });

  it('announces a removal without re-announcing the publish', async () => {
    const notify = vi.fn().mockResolvedValue(true);
    const { svc } = makeService(
      {
        post: {
          id: 'post-1',
          state: 'PUBLISHED',
          removedAt: new Date(),
          releaseURL: 'https://x.com/u/status/1',
          projectId: 'project-1',
          providerIdentifier: 'x',
          integration: { providerIdentifier: 'x' },
        },
      },
      { notify }
    );

    await svc.notifySendOutcome('org-1', 'exec-1');

    expect(notify.mock.calls.map((call) => call[0].eventKey)).toEqual([
      'post.removed',
      'post.published',
    ]);
    expect(notify.mock.calls[0][0].dedupKey).toBe('post.removed:post-1');
  });

  it('does nothing when the client is not wired', async () => {
    const { svc } = makeService();

    await expect(svc.notifySendOutcome('org-1', 'exec-1')).resolves.toBeUndefined();
  });
});
