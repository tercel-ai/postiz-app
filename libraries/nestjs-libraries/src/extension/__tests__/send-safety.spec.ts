import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSend, sendNow as now } from './support/send-fixture';
import { canonicalSendAccount, sendHash } from '../send-coordination.utils';
import {
  controlledSubmit,
  withControlledSubmit,
  ControlledSubmitContext,
} from '../controlled-api-submit';

beforeEach(() => {
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
  vi.stubEnv(
    'SEND_EXECUTION_CREDENTIAL_KEY',
    'test-send-execution-key-with-at-least-32-characters'
  );
});
afterEach(() => vi.unstubAllEnvs());
const actor = { id: '123', idNamespace: 'x.rest_id' };
describe('execution safety across channels and recoveries', () => {
  it('shares the content lock across API and extension reservations', async () => {
    const { service, create, db } = setupSend();
    await create();
    await db.$transaction((tx: any) =>
      service.reserveIn(
        tx,
        'org',
        'root',
        'EXTENSION',
        'browser',
        { extensionNodeId: 'node' },
        now
      )
    );
    await expect(
      service.reserveApi('org', 'root', 'workflow', now)
    ).rejects.toThrow('SEND_ALREADY_OWNED');
    expect(db.rows('sendExecution')).toHaveLength(1);
  });
  it('allows failover only for an expired reservation with no permit', async () => {
    const { service, create, db } = setupSend();
    await create();
    const old = await service.reserveApi('org', 'root', 'old', now);
    const next = new Date(now.getTime() + 121_000);
    const latest = await service.reserveApi('org', 'root', 'new', next);
    expect(latest.fencingVersion).toBeGreaterThan(old.fencingVersion);
    expect(db.rows('sendExecution')[0].status).toBe('EXPIRED');
    await expect(
      service.authorizeApiSegment('org', old.id, 0, actor, next)
    ).rejects.toThrow('STALE_SEND_EXECUTION');
    await expect(
      service.apiOutcome(
        'org',
        old.id,
        0,
        {
          status: 'definitely_not_submitted',
          eventId: 'stale',
          stopped: true,
          evidence: 'stopped',
        },
        next
      )
    ).rejects.toThrow('SEND_NOT_AUTHORIZED');
    expect(db.rows('sendIntent')[0].activeExecutionId).toBe(latest.id);
  });
  it('does not let two content units share the same actor write lock', async () => {
    const { service, create, db } = setupSend();
    await create();
    await create('second');
    const a = await service.reserveApi('org', 'root', 'a', now);
    const b = await service.reserveApi('org', 'second', 'b', now);
    await service.authorizeApiSegment('org', a.id, 0, actor, now);
    await expect(
      service.authorizeApiSegment('org', b.id, 0, actor, now)
    ).rejects.toThrow('ACCOUNT_WRITE_BUSY');
    expect(db.rows('sendQuotaReservation')).toHaveLength(1);
  });
  it('freezes content and rejects credential replacement before authorization', async () => {
    const { service, create, db } = setupSend();
    await create();
    const e = await service.reserveApi('org', 'root', 'a', now);
    await expect(
      service.authorizeApiSegment(
        'org',
        e.id,
        0,
        { ...actor, credentialHash: sendHash('replaced') },
        now
      )
    ).rejects.toThrow('SEND_CREDENTIAL_CHANGED');
    db.rows('post')[0].content = 'edited';
    await expect(
      service.authorizeApiSegment('org', e.id, 0, actor, now)
    ).rejects.toThrow('SEND_CONTENT_CHANGED');
    expect(db.rows('sendQuotaBucket')).toHaveLength(0);
  });
  it('requires every preceding segment to be confirmed and applies spacing from confirmation', async () => {
    const { service, create, db, quotas } = setupSend();
    await create();
    db.seed('post', {
      ...db.rows('post')[0],
      id: 'child',
      parentPostId: 'root',
      content: 'part 2',
    });
    quotas.resolve.mockResolvedValue({ gapMs: 60_000, budgets: [] });
    const e = await service.reserveApi('org', 'root', 'a', now);
    await expect(
      service.authorizeApiSegment('org', e.id, 1, actor, now)
    ).rejects.toThrow('PREVIOUS_SEGMENT_NOT_CONFIRMED');
    await service.authorizeApiSegment('org', e.id, 0, actor, now);
    await service.apiOutcome(
      'org',
      e.id,
      0,
      { status: 'confirmed', eventId: 'one', platformId: 'tweet1' },
      now
    );
    await expect(
      service.authorizeApiSegment('org', e.id, 1, actor, now)
    ).rejects.toThrow('ACCOUNT_WRITE_INTERVAL');
    expect(
      (
        await service.authorizeApiSegment(
          'org',
          e.id,
          1,
          actor,
          new Date(now.getTime() + 60_000)
        )
      ).granted
    ).toBe(true);
    await service.apiOutcome(
      'org',
      e.id,
      1,
      { status: 'unknown', eventId: 'two' },
      new Date(now.getTime() + 61_000)
    );
    await expect(service.retry('org', 'root', 'user', now)).rejects.toThrow(
      'SEND_RETRY_UNSAFE'
    );
  });
  it('persists conflicting success evidence and never frees the current owner', async () => {
    const { service, create, db } = setupSend();
    await create();
    const e = await service.reserveApi('org', 'root', 'a', now);
    await service.authorizeApiSegment('org', e.id, 0, actor, now);
    const later = new Date(now.getTime() + 31_000);
    await service.apiOutcome(
      'org',
      e.id,
      0,
      {
        status: 'definitely_not_submitted',
        eventId: 'stop',
        stopped: true,
        evidence: 'adapter stopped before invocation',
      },
      later
    );
    await service.retry('org', 'root', 'user', later);
    const current = await service.reserveApi('org', 'root', 'new', later);
    await expect(
      service.apiOutcome(
        'org',
        e.id,
        0,
        { status: 'confirmed', eventId: 'late', platformId: 'tweet' },
        later
      )
    ).rejects.toThrow('SEND_OUTCOME_CONFLICT');
    expect(db.rows('sendIntent')[0]).toMatchObject({
      status: 'RECONCILING',
      activeExecutionId: current.id,
      hasConfirmedSegments: true,
    });
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({
      heldUnits: 0,
      confirmedUnits: 1,
    });
    expect(db.rows('post')[0]).toMatchObject({
      state: 'PUBLISHED',
      releaseId: 'tweet',
    });
    expect(db.rows('sendOutcomeEvent')).toHaveLength(2);
    await expect(
      service.authorizeApiSegment('org', current.id, 0, actor, later)
    ).rejects.toThrow('STALE_SEND_EXECUTION');
  });
  it('rejects request reuse with different result facts without rolling back the original', async () => {
    const { service, create, db } = setupSend();
    await create();
    const e = await service.reserveApi('org', 'root', 'a', now);
    await service.authorizeApiSegment('org', e.id, 0, actor, now);
    await service.apiOutcome(
      'org',
      e.id,
      0,
      { status: 'confirmed', eventId: 'one', platformId: 'tweet' },
      now
    );
    await expect(
      service.apiOutcome(
        'org',
        e.id,
        0,
        { status: 'unknown', eventId: 'one' },
        now
      )
    ).rejects.toThrow('SEND_OUTCOME_EVENT_CONFLICT');
    expect(db.rows('sendIntent')[0].status).toBe('SUCCEEDED');
  });
  it('shares a canonical actor key across OAuth and plugin integration aliases', () => {
    expect(
      canonicalSendAccount('org', 'reddit', 'reddit.user_id', 't2_ABC')
    ).toBe(canonicalSendAccount('org', 'reddit', 'reddit.user_id', 'abc'));
    expect(canonicalSendAccount('org', 'x', 'x.rest_id', 'ABC')).not.toBe(
      canonicalSendAccount('org', 'x', 'x.rest_id', 'abc')
    );
  });
});

describe('actual network submit boundary', () => {
  function context(granted = true): ControlledSubmitContext {
    return {
      consumed: false,
      invoked: false,
      authorized: false,
      authorize: vi
        .fn()
        .mockResolvedValue({
          granted,
          submitBefore: new Date(Date.now() + 30_000).toISOString(),
          serverNow: new Date().toISOString(),
        }),
    };
  }
  it('allows preparation but consumes the network mutation only once', async () => {
    const state = context();
    const network = vi.fn().mockResolvedValue('sent');
    await withControlledSubmit(state, async () => {
      expect(await controlledSubmit(network)).toBe('sent');
      await expect(controlledSubmit(network)).rejects.toThrow(
        'SEND_PERMIT_ALREADY_CONSUMED'
      );
    });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('does not invoke a network write after a denied or expired permission', async () => {
    const network = vi.fn();
    const state = context(false);
    await expect(
      withControlledSubmit(state, () => controlledSubmit(network))
    ).rejects.toThrow('SEND_PERMIT_NOT_GRANTED');
    state.consumed = false;
    state.authorize = vi
      .fn()
      .mockResolvedValue({
        granted: true,
        serverNow: now.toISOString(),
        submitBefore: now.toISOString(),
      });
    await expect(
      withControlledSubmit(state, () => controlledSubmit(network))
    ).rejects.toThrow('SEND_PERMIT_EXPIRED');
    expect(network).not.toHaveBeenCalled();
  });
  it('never replays a request after a network timeout', async () => {
    const state = context();
    const network = vi.fn().mockRejectedValue(new Error('timeout'));
    await withControlledSubmit(state, async () => {
      await expect(controlledSubmit(network)).rejects.toThrow('timeout');
      await expect(controlledSubmit(network)).rejects.toThrow(
        'SEND_PERMIT_ALREADY_CONSUMED'
      );
    });
    expect(state.invoked).toBe(true);
    expect(network).toHaveBeenCalledTimes(1);
  });
});

it.each(['linkedin','linkedin-page'])('blocks both legacy LinkedIn transport aliases after %s enrollment, even when the switch is disabled', async provider => {
  const {db,service}=setupSend();
  db.rows('integration')[0].providerIdentifier=provider;
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED','false');
  expect(await service.legacyBlockedPlatforms('org')).toEqual(expect.arrayContaining(['linkedin','linkedin-page']));
  expect(await service.legacyBlockedPlatforms('other-org')).toEqual([]);
});
