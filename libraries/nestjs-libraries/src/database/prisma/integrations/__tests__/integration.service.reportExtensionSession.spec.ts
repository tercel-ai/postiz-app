// What an hourly extension session report is allowed to CHANGE.
//
// The report is unattended and org-wide, so the interesting cases are all about
// restraint: which platforms may have a channel created from a browser session,
// what a matched row may have corrected on it, and what happens to an org that
// is already at its channel allowance.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@gitroom/nestjs-libraries/engage/safe-media-fetch', () => ({
  fetchMediaAsDataUri: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
}));

import { IntegrationService } from '../integration.service';

interface Row {
  id: string;
  internalId: string;
  profile: string | null;
  metadata: unknown;
  name?: string;
  picture?: string | null;
}

function makeService(rowsByPlatform: Record<string, Row[]> = {}) {
  const repository = {
    getIntegrationsForPlatform: vi.fn(
      async (_org: string, platform: string) => rowsByPlatform[platform] ?? []
    ),
    recordExtensionSession: vi.fn(async () => undefined),
    createOrUpdateIntegration: vi.fn(async () => ({
      id: 'created_1',
      metadata: null,
    })),
  };

  const service = new IntegrationService(
    repository as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );

  (service as any).storage = {
    uploadSimple: vi.fn(async () => 'https://files.aisee.live/new.jpeg'),
  };

  return { service, repository };
}

function report(platforms: any[], checkedAt = '2026-09-08T06:05:06.943Z') {
  return { checkedAt, platforms } as any;
}

describe('IntegrationService.reportExtensionSession — creating a channel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should create the channel when a handle-only platform has no row yet', async () => {
    const { service, repository } = makeService();

    await service.reportExtensionSession(
      'org_1',
      report([
        {
          platform: 'quora',
          loggedIn: true,
          handle: 'Tercel-Yi',
          name: 'Tercel Yi',
          picture: 'https://qsf.quoracdn.net/main-thumb-1-200.jpeg',
        },
      ]),
      { canCreateChannels: true }
    );

    expect(repository.createOrUpdateIntegration).toHaveBeenCalledTimes(1);
    const args = repository.createOrUpdateIntegration.mock.calls[0];
    expect(args[2]).toBe('org_1'); // org
    expect(args[3]).toBe('Tercel Yi'); // name
    expect(args[6]).toBe('Tercel-Yi'); // internalId
    expect(args[7]).toBe('quora'); // provider
    expect(args[8]).toBe('Tercel-Yi'); // token — the handle IS the credential
    expect(args[11]).toBe('Tercel-Yi'); // username → profile
  });

  it('should hand storage a guarded download rather than the platform url', async () => {
    // uploadSimple would fetch a raw url with no SSRF, size or content-type
    // guard; a data URI it ingests without touching the network.
    const { service, repository } = makeService();

    await service.reportExtensionSession(
      'org_1',
      report([
        {
          platform: 'quora',
          loggedIn: true,
          handle: 'Tercel-Yi',
          picture: 'https://qsf.quoracdn.net/main-thumb-1-200.jpeg',
        },
      ]),
      { canCreateChannels: true }
    );

    // picture argument of the service-level createOrUpdateIntegration, as it
    // reaches the repository after the upload step.
    expect((service as any).storage.uploadSimple).toHaveBeenCalledWith(
      'data:image/jpeg;base64,AAAA'
    );
    expect(repository.createOrUpdateIntegration.mock.calls[0][4]).toBe(
      'https://files.aisee.live/new.jpeg'
    );
  });

  it('should still create the channel when its avatar cannot be fetched', async () => {
    const { fetchMediaAsDataUri } = await import(
      '@gitroom/nestjs-libraries/engage/safe-media-fetch'
    );
    (fetchMediaAsDataUri as any).mockRejectedValueOnce(new Error('403'));

    const { service, repository } = makeService();

    await service.reportExtensionSession(
      'org_1',
      report([
        {
          platform: 'quora',
          loggedIn: true,
          handle: 'Tercel-Yi',
          picture: 'https://qsf.quoracdn.net/main-thumb-1-200.jpeg',
        },
      ]),
      { canCreateChannels: true }
    );

    expect(repository.createOrUpdateIntegration).toHaveBeenCalledTimes(1);
    expect(repository.createOrUpdateIntegration.mock.calls[0][4]).toBeUndefined();
  });

  it('should mark the new channel as reachable through the extension right away', async () => {
    const { service, repository } = makeService();

    await service.reportExtensionSession(
      'org_1',
      report([{ platform: 'hackernews', loggedIn: true, handle: 'tercelyi' }]),
      { canCreateChannels: true }
    );

    expect(repository.recordExtensionSession).toHaveBeenCalledWith(
      [{ id: 'created_1', metadata: null }],
      'created_1',
      'tercelyi',
      new Date('2026-09-08T06:05:06.943Z')
    );
  });

  it('should create nothing when the org is at its channel allowance', async () => {
    const { service, repository } = makeService();

    await service.reportExtensionSession(
      'org_1',
      report([{ platform: 'quora', loggedIn: true, handle: 'Tercel-Yi' }]),
      { canCreateChannels: false }
    );

    expect(repository.createOrUpdateIntegration).not.toHaveBeenCalled();
  });

  it('should default to creating nothing when the caller says nothing', async () => {
    const { service, repository } = makeService();

    await service.reportExtensionSession(
      'org_1',
      report([{ platform: 'quora', loggedIn: true, handle: 'Tercel-Yi' }])
    );

    expect(repository.createOrUpdateIntegration).not.toHaveBeenCalled();
  });

  it('should create a channel on the OAuth-capable platforms too — the session is the credential', async () => {
    const { service, repository } = makeService();

    await service.reportExtensionSession(
      'org_1',
      report([
        { platform: 'x', loggedIn: true, id: '2035914746877345792', handle: 'aipartnerup' },
        { platform: 'reddit', loggedIn: true, id: 't2_abc', handle: 'someone' },
        { platform: 'devto', loggedIn: true, id: '42', handle: 'tercelyi' },
        { platform: 'linkedin', loggedIn: true, id: 'li-1', handle: 'tercel-yi' },
      ]),
      { canCreateChannels: true }
    );

    expect(repository.createOrUpdateIntegration).toHaveBeenCalledTimes(4);
    expect(
      repository.createOrUpdateIntegration.mock.calls.map((call) => call[7])
    ).toEqual(['x', 'reddit', 'devto', 'linkedin']);
  });

  it('should create the channel with no token expiry, so the refresh sweep leaves it alone', async () => {
    // A non-null tokenExpiration puts the row in
    // getIntegrationsWithTokenExpiration; for a refreshCron provider (x) that
    // starts a refresh against the empty refreshToken, whose permanent failure
    // marks the channel refreshNeeded and disconnects it within the hour.
    const { service, repository } = makeService();

    await service.reportExtensionSession(
      'org_1',
      report([
        { platform: 'x', loggedIn: true, id: '2035914746877345792', handle: 'aipartnerup' },
      ]),
      { canCreateChannels: true }
    );

    expect(repository.createOrUpdateIntegration.mock.calls[0][10]).toBe(0);
  });

  it('should store a Reddit id in the bare form the OAuth flow uses', async () => {
    // The session JWT carries the `t2_`-prefixed fullname; /api/v1/me returns
    // the bare id. Creating with the prefix would make a later OAuth connect
    // add a SECOND channel for the same account instead of updating this one.
    const { service, repository } = makeService();

    await service.reportExtensionSession(
      'org_1',
      report([{ platform: 'reddit', loggedIn: true, id: 't2_abc123', handle: 'someone' }]),
      { canCreateChannels: true }
    );

    expect(repository.createOrUpdateIntegration.mock.calls[0][6]).toBe('abc123');
  });

  it('should refuse a platform the extension cannot publish at all', async () => {
    // A channel nothing can send through is worse than no channel: it would
    // count against the plan and park every post scheduled to it.
    const { service, repository } = makeService();

    await service.reportExtensionSession(
      'org_1',
      report([{ platform: 'mastodon', loggedIn: true, id: 'm-1', handle: 'someone' }]),
      { canCreateChannels: true }
    );

    expect(repository.createOrUpdateIntegration).not.toHaveBeenCalled();
  });

  it('should create nothing for a platform the browser is signed out of', async () => {
    const { service, repository } = makeService();

    await service.reportExtensionSession(
      'org_1',
      report([{ platform: 'quora', loggedIn: false }]),
      { canCreateChannels: true }
    );

    expect(repository.createOrUpdateIntegration).not.toHaveBeenCalled();
  });

  it('should create nothing when the probe could not name the account', async () => {
    const { service, repository } = makeService();

    await service.reportExtensionSession(
      'org_1',
      report([{ platform: 'medium', loggedIn: true }]),
      { canCreateChannels: true }
    );

    expect(repository.createOrUpdateIntegration).not.toHaveBeenCalled();
  });

  it('should keep reporting the other platforms when one creation fails', async () => {
    const { service, repository } = makeService({
      x: [{ id: 'int_x', internalId: 'x-1', profile: 'aipartnerup', metadata: null }],
    });
    repository.createOrUpdateIntegration.mockRejectedValueOnce(
      new Error('unique constraint')
    );

    await service.reportExtensionSession(
      'org_1',
      report([
        { platform: 'quora', loggedIn: true, handle: 'Tercel-Yi' },
        { platform: 'x', loggedIn: true, id: 'x-1', handle: 'aipartnerup' },
      ]),
      { canCreateChannels: true }
    );

    expect(repository.recordExtensionSession).toHaveBeenCalledTimes(1);
    expect(repository.recordExtensionSession.mock.calls[0][1]).toBe('int_x');
  });
});

describe('IntegrationService.reportExtensionSession — correcting an existing row', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should correct a handle that changed on the platform', async () => {
    const { service, repository } = makeService({
      x: [
        {
          id: 'int_x',
          internalId: '2035914746877345792',
          profile: 'oldhandle',
          metadata: null,
          picture: 'https://files.aisee.live/ok.jpeg',
        },
      ],
    });

    await service.reportExtensionSession(
      'org_1',
      report([
        {
          platform: 'x',
          loggedIn: true,
          id: '2035914746877345792',
          handle: 'aipartnerup',
        },
      ])
    );

    expect(repository.recordExtensionSession.mock.calls[0][4]).toEqual({
      profile: 'aipartnerup',
    });
  });

  it('should replace a picture that was stored as a non-image', async () => {
    const { service, repository } = makeService({
      x: [
        {
          id: 'int_x',
          internalId: 'x-1',
          profile: 'aipartnerup',
          metadata: null,
          picture: 'https://files.aisee.live/HhV1fkROgq.html',
        },
      ],
    });

    await service.reportExtensionSession(
      'org_1',
      report([
        {
          platform: 'x',
          loggedIn: true,
          id: 'x-1',
          handle: 'aipartnerup',
          picture: 'https://pbs.twimg.com/profile_images/1.jpg',
        },
      ])
    );

    expect(repository.recordExtensionSession.mock.calls[0][4]).toEqual({
      picture: 'https://files.aisee.live/new.jpeg',
    });
  });

  it('should leave a good row completely alone', async () => {
    const { service, repository } = makeService({
      x: [
        {
          id: 'int_x',
          internalId: 'x-1',
          profile: 'aipartnerup',
          metadata: null,
          picture: 'https://files.aisee.live/ok.jpeg',
        },
      ],
    });

    await service.reportExtensionSession(
      'org_1',
      report([
        {
          platform: 'x',
          loggedIn: true,
          id: 'x-1',
          handle: 'aipartnerup',
          picture: 'https://pbs.twimg.com/profile_images/1.jpg',
        },
      ])
    );

    expect(repository.recordExtensionSession.mock.calls[0][4]).toEqual({});
  });

  it('should record the session but correct nothing when no row matched', async () => {
    const { service, repository } = makeService({
      x: [
        {
          id: 'int_x',
          internalId: 'someone-else',
          profile: 'someoneelse',
          metadata: null,
          picture: null,
        },
      ],
    });

    await service.reportExtensionSession(
      'org_1',
      report([
        {
          platform: 'x',
          loggedIn: true,
          id: 'x-1',
          handle: 'aipartnerup',
          picture: 'https://pbs.twimg.com/profile_images/1.jpg',
        },
      ])
    );

    const call = repository.recordExtensionSession.mock.calls[0];
    expect(call[1]).toBeNull(); // matchedId
    expect(call[4]).toEqual({});
  });

  it('should still record the session when the avatar could not be re-hosted', async () => {
    const { fetchMediaAsDataUri } = await import(
      '@gitroom/nestjs-libraries/engage/safe-media-fetch'
    );
    (fetchMediaAsDataUri as any).mockRejectedValueOnce(new Error('403'));

    const { service, repository } = makeService({
      x: [
        {
          id: 'int_x',
          internalId: 'x-1',
          profile: 'aipartnerup',
          metadata: null,
          picture: null,
        },
      ],
    });

    await service.reportExtensionSession(
      'org_1',
      report([
        {
          platform: 'x',
          loggedIn: true,
          id: 'x-1',
          handle: 'aipartnerup',
          picture: 'https://pbs.twimg.com/profile_images/1.jpg',
        },
      ])
    );

    expect(repository.recordExtensionSession).toHaveBeenCalledTimes(1);
    expect(repository.recordExtensionSession.mock.calls[0][4]).toEqual({});
  });
});
