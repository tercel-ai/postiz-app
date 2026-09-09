import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiseeNotificationChannel,
  AiseeNotificationClient,
  AiseeNotificationEvent,
} from '../aisee-notification.client';

const ORG = 'org-1';
const OWNER = 'aisee-user-1';

function makeClient(resolved: string = OWNER) {
  const creditService = {
    resolveOwnerUserId: vi.fn().mockResolvedValue(resolved),
  };
  const client = new AiseeNotificationClient(creditService as any);
  return { client, creditService };
}

function okResponse(created: boolean) {
  return { ok: true, json: async () => ({ success: true, created }) } as any;
}

describe('AiseeNotificationClient', () => {
  beforeEach(() => {
    process.env.AISEE_ORCHESTRATOR_URL = 'http://aisee.test';
    process.env.JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.AISEE_ORCHESTRATOR_URL;
    delete process.env.JWT_SECRET;
    vi.restoreAllMocks();
  });

  it('posts the event to the emit endpoint with a system-internal token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(true));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = makeClient();

    const created = await client.notify({
      organizationId: ORG,
      eventKey: AiseeNotificationEvent.POST_PUBLISHED,
      dedupKey: 'post.published:p1',
      data: { platform: 'X' },
    });

    expect(created).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://aisee.test/post-agent/notification/emit');
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    expect(JSON.parse(init.body)).toEqual({
      user_id: OWNER,
      event_key: 'post.published',
      dedup_key: 'post.published:p1',
      data: { platform: 'X' },
      channel: 'postiz',
    });
  });

  it('resolves the organization to its owning Aisee user', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(true)));
    const { client, creditService } = makeClient('owner-42');

    await client.notify({
      organizationId: ORG,
      eventKey: AiseeNotificationEvent.ENGAGE_REPLIED,
      dedupKey: 'engage.replied:r1',
    });

    expect(creditService.resolveOwnerUserId).toHaveBeenCalledWith(ORG);
  });

  it('sends the engage channel when asked', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(true));
    vi.stubGlobal('fetch', fetchMock);
    const { client } = makeClient();

    await client.notify({
      organizationId: ORG,
      eventKey: AiseeNotificationEvent.ENGAGE_REPLIED,
      dedupKey: 'engage.replied:r1',
      channel: AiseeNotificationChannel.ENGAGE,
    });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).channel).toBe('engage');
  });

  it('reports false when Aisee deduplicated the event', async () => {
    // A repeat delivery is the expected outcome of a workflow replay, not an error.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(false)));
    const { client } = makeClient();

    await expect(
      client.notify({
        organizationId: ORG,
        eventKey: AiseeNotificationEvent.POST_PUBLISHED,
        dedupKey: 'post.published:p1',
      })
    ).resolves.toBe(false);
  });

  it('never throws when the emit endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'boom',
      } as any)
    );
    const { client } = makeClient();

    await expect(
      client.notify({
        organizationId: ORG,
        eventKey: AiseeNotificationEvent.POST_PUBLISHED,
        dedupKey: 'post.published:p1',
      })
    ).resolves.toBe(false);
  });

  it('never throws when the network is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const { client } = makeClient();

    await expect(
      client.notify({
        organizationId: ORG,
        eventKey: AiseeNotificationEvent.POST_PUBLISHED,
        dedupKey: 'post.published:p1',
      })
    ).resolves.toBe(false);
  });

  it('never throws when the owner lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const creditService = {
      resolveOwnerUserId: vi.fn().mockRejectedValue(new Error('db down')),
    };
    const client = new AiseeNotificationClient(creditService as any);

    await expect(
      client.notify({
        organizationId: ORG,
        eventKey: AiseeNotificationEvent.POST_PUBLISHED,
        dedupKey: 'post.published:p1',
      })
    ).resolves.toBe(false);
  });

  it('is disabled, and makes no call, without AISEE_ORCHESTRATOR_URL', async () => {
    delete process.env.AISEE_ORCHESTRATOR_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { client } = makeClient();

    expect(client.enabled).toBe(false);
    await expect(
      client.notify({
        organizationId: ORG,
        eventKey: AiseeNotificationEvent.POST_PUBLISHED,
        dedupKey: 'post.published:p1',
      })
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
