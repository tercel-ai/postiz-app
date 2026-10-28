import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSend, sendNow as now } from './support/send-fixture';
import { SendQuotaService, SendBudget } from '../send-quota.service';
import { memorySendDatabase } from './support/memory-send-database';

beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
function budget(extra: Partial<SendBudget> = {}): SendBudget {
  return {
    key: 'budget',
    scope: 'PROJECT',
    dimension: 'REPLY_ROOTS_AUTO',
    limit: 1,
    units: 1,
    windowStart: new Date('2026-10-15T00:00:00Z'),
    windowEnd: new Date('2026-10-16T00:00:00Z'),
    timezone: 'UTC',
    policyVersion: 'v1',
    projectId: 'project',
    platform: 'x',
    ...extra,
  };
}
describe('quota reservation ledger', () => {
  it('corrects a late confirmation in budgets created after the original release exactly once', async () => {
    const db = memorySendDatabase();
    const q = new SendQuotaService();
    db.seed('sendExecution', {
      id: 'old', organizationId: 'org', projectId: 'project', platform: 'x', action: 'REPLY',
    });
    db.seed('sendSegment', {
      executionId: 'old', organizationId: 'org', segmentIndex: 0,
      authorizedAt: now, status: 'NOT_SUBMITTED',
    });
    await db.$transaction((tx: any) => q.reserve(tx, 'org', 'new', 0, [budget({ limit: 2 })], now));
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({ confirmedUnits: 0, heldUnits: 1 });
    await db.$transaction((tx: any) => q.correctLateConfirmation(tx, 'org', 'old', 0, now));
    await db.$transaction((tx: any) => q.correctLateConfirmation(tx, 'org', 'old', 0, now));
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({ confirmedUnits: 1, heldUnits: 1 });
    await expect(db.$transaction((tx: any) => q.reserve(tx, 'org', 'third', 0, [budget({ limit: 2 })], now)))
      .rejects.toThrow('SEND_QUOTA_EXHAUSTED');
  });
  it('rolls back every budget when the final shared budget is exhausted', async () => {
    const db = memorySendDatabase();
    const q = new SendQuotaService();
    db.seed('sendQuotaBucket', {
      ...budget({ key: 'z' }),
      id: 'z',
      organizationId: 'org',
      confirmedUnits: 1,
    });
    await expect(
      db.$transaction((tx: any) =>
        q.reserve(
          tx,
          'org',
          'e',
          0,
          [budget({ key: 'a' }), budget({ key: 'z' })],
          now
        )
      )
    ).rejects.toThrow('SEND_QUOTA_EXHAUSTED');
    expect(db.rows('sendQuotaBucket')).toHaveLength(1);
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
  });
  it('uses the same bucket when a limit or policy version changes', async () => {
    const db = memorySendDatabase();
    const q = new SendQuotaService();
    await db.$transaction((tx: any) =>
      q.reserve(tx, 'org', 'one', 0, [budget()], now)
    );
    await expect(
      db.$transaction((tx: any) =>
        q.reserve(
          tx,
          'org',
          'two',
          0,
          [budget({ limit: 0, policyVersion: 'v2' })],
          now
        )
      )
    ).rejects.toThrow('SEND_QUOTA_EXHAUSTED');
    await db.$transaction((tx: any) =>
      q.reserve(
        tx,
        'org',
        'two',
        0,
        [budget({ limit: 2, policyVersion: 'v3' })],
        now
      )
    );
    expect(db.rows('sendQuotaBucket')).toHaveLength(1);
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({
      heldUnits: 2,
      confirmedUnits: 0,
    });
  });
  it('records manual facts in the automatic budget without imposing that automatic cap', async () => {
    const db = memorySendDatabase();
    const q = new SendQuotaService();
    await q.reserve(
      db as any,
      'org',
      'manual',
      0,
      [budget({ limit: 0, enforce: false })],
      now
    );
    await q.settle(db as any, 'org', 'manual', 0, true, now);
    await expect(
      q.reserve(db as any, 'org', 'auto', 0, [budget()], now)
    ).rejects.toThrow('SEND_QUOTA_EXHAUSTED');
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({
      heldUnits: 0,
      confirmedUnits: 1,
    });
  });
  it('seeds legacy published roots and controlled holds without counting thread comments as business roots', async () => {
    const db = memorySendDatabase();
    const q = new SendQuotaService();
    db.seed('post', {
      organizationId: 'org',
      projectId: 'project',
      providerIdentifier: 'x',
      state: 'PUBLISHED',
      publishDate: now,
      source: 'engage',
      parentPostId: null,
    });
    db.seed('post', {
      organizationId: 'org',
      projectId: 'project',
      providerIdentifier: 'x',
      state: 'PUBLISHED',
      publishDate: now,
      source: 'engage',
      parentPostId: 'root',
    });
    db.seed('sendExecution', {
      id: 'old',
      organizationId: 'org',
      projectId: 'project',
      platform: 'x',
      action: 'REPLY',
    });
    db.seed('sendSegment', {
      organizationId: 'org',
      executionId: 'old',
      segmentIndex: 0,
      authorizedAt: now,
      status: 'UNKNOWN',
    });
    await q.reserve(db as any, 'org', 'new', 0, [budget({ limit: 3 })], now);
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({
      confirmedUnits: 1,
      heldUnits: 2,
    });
    await q.settle(
      db as any,
      'org',
      'new',
      0,
      true,
      new Date('2026-10-16T12:00:00Z')
    );
    await q.settle(
      db as any,
      'org',
      'new',
      0,
      true,
      new Date('2026-10-16T12:00:00Z')
    );
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({
      confirmedUnits: 2,
      heldUnits: 1,
    });
  });
  it.each([-1, 1.1, NaN, 2147483648])(
    'rejects invalid limits %s before reserving',
    async (limit) => {
      const db = memorySendDatabase();
      const q = new SendQuotaService();
      await expect(
        q.reserve(db as any, 'org', 'e', 0, [budget({ limit })], now)
      ).rejects.toThrow('SEND_QUOTA_POLICY_INVALID');
      expect(db.rows('sendQuotaReservation')).toHaveLength(0);
    }
  );
});

describe('existing send policy and quota compatibility', () => {
  async function policy() {
    const fixture = setupSend();
    await fixture.create();
    fixture.quotas.resolve.mockRestore();
    const intent = {
      ...fixture.db.rows('sendIntent')[0],
      action: 'REPLY',
      context: { channel: 'channel', matchedKeywords: ['keyword'] },
    };
    const account = {
      ...fixture.db.rows('accountWriteState')[0],
      dailyWriteLimit: 100,
      timezone: 'Asia/Taipei',
    };
    fixture.db.seed('engageConfig', {
      organizationId: 'org',
      projectId: 'project',
      metadata: {
        automationEnabled: true,
        autoReplyEnabled: true,
        replyPolicies: {
          x: {
            autoReplyEnabled: true,
            dailyReplyLimit: 8,
            windowStart: '00:00',
            windowEnd: '23:59',
            timezone: 'UTC',
          },
        },
      },
    });
    return { ...fixture, intent, account };
  }
  it('keeps a 150-minute automatic project cadence out of the three-minute X account cooldown', async () => {
    const { db, quotas, intent, account } = await policy();
    Object.assign(db.rows('engageConfig')[0].metadata.replyPolicies.x, {
      dailyReplyLimit: 4, windowStart: '08:00', windowEnd: '18:00', timezone: 'UTC',
    });
    const automatic = await quotas.resolve(db as any, { ...intent, sendOrigin: 'AUTOMATION' }, account, 0, now);
    expect(automatic.gapMs).toBe(3 * 60_000);
    expect(automatic.budgets.find(b => b.dimension === 'REPLY_ROOTS_AUTO')).toMatchObject({ limit: 4, enforce: true });
  });

  it('allows a manual reply after account pacing while retaining automatic project spacing', async () => {
    const { db, service, create, quotas } = await policy();
    Object.assign(db.rows('engageConfig')[0].metadata.replyPolicies.x, {
      dailyReplyLimit: 4, windowStart: '08:00', windowEnd: '18:00', timezone: 'UTC',
    });
    Object.assign(db.rows('sendIntent')[0], { action: 'REPLY', sendOrigin: 'AUTOMATION' });
    const actor = { id: '123', idNamespace: 'x.rest_id' };
    const automatic = await service.reserveApi('org', 'root', 'automatic', now);
    await service.authorizeApiSegment('org', automatic.id, 0, actor, now);
    await service.apiOutcome('org', automatic.id, 0, {
      status: 'confirmed', eventId: 'automatic-confirmed', platformId: 'automatic-reply',
    }, now);
    await create('manual');
    const manualIntent = db.rows('sendIntent').find(row => row.rootPostId === 'manual');
    manualIntent.action = 'REPLY';
    const manualPost = db.rows('post').find(row => row.id === 'manual');
    const session = {
      integrationId: 'account', verificationStatus: 'VERIFIED',
      verificationExpiresAt: new Date(now.getTime() + 4 * 60 * 60_000),
      accountIdentity: { id: '123', namespace: 'x.rest_id' },
    };
    const before = new Date(now.getTime() + 3 * 60_000 - 1);
    expect(await service.claimableIn(db as any, 'org', manualPost, session as any, 'REPLY', before)).toBe(false);
    const later = new Date(now.getTime() + 3 * 60_000);
    expect(await service.claimableIn(db as any, 'org', manualPost, session as any, 'REPLY', later)).toBe(true);
    const manual = await service.reserveApi('org', 'manual', 'manual', later);
    expect((await service.authorizeApiSegment('org', manual.id, 0, actor, later)).granted).toBe(true);
    await service.apiOutcome('org', manual.id, 0, {
      status: 'confirmed', eventId: 'manual-confirmed', platformId: 'manual-reply',
    }, later);
    const account = db.rows('accountWriteState')[0];
    expect(account.nextWriteNotBefore).toEqual(new Date(later.getTime() + 3 * 60_000));
    await expect(quotas.resolve(db as any, { ...manualIntent, sendOrigin: 'AUTOMATION' }, account, 0, later))
      .rejects.toThrow('PROJECT_REPLY_INTERVAL');
    const nextAutomatic = new Date(later.getTime() + 150 * 60_000);
    await expect(quotas.resolve(db as any, { ...manualIntent, sendOrigin: 'AUTOMATION' }, account, 0, nextAutomatic))
      .resolves.toHaveProperty('gapMs', 3 * 60_000);
  });

  it('keeps business root quotas separate from each actual platform write', async () => {
    const { db, quotas, intent, account } = await policy();
    const root = await quotas.resolve(db as any, intent, account, 0, now);
    const child = await quotas.resolve(db as any, intent, account, 1, now);
    expect(
      root.budgets.some(
        (b) => b.dimension === 'REPLY_ROOTS_AUTO' && b.enforce === false
      )
    ).toBe(true);
    expect(
      child.budgets.every((b) => !b.dimension.startsWith('REPLY_ROOTS'))
    ).toBe(true);
    expect(child.budgets.some((b) => b.dimension === 'PLATFORM_WRITES')).toBe(
      true
    );
    expect(
      root.budgets
        .find((b) => b.dimension === 'PLATFORM_WRITES')
        ?.windowStart.toISOString()
    ).toBe('2026-10-14T16:00:00.000Z');
  });
  it('applies manual plan and keyword limits without turning them into automatic hard caps', async () => {
    const { db, quotas, intent, account } = await policy();
    db.seed('operationPlan', {
      organizationId: 'org',
      projectId: 'project',
      status: 'READY',
      startsAt: new Date('2026-10-01'),
      endsAt: new Date('2026-11-01'),
      planPayload: {
        engagePolicies: [
          {
            platform: 'x',
            enabled: true,
            targetRepliesPerDay: 4,
            dailyHardCap: 2,
            keywordTargets: { key: 1 },
          },
        ],
      },
    });
    db.seed('engageKeyword', {
      id: 'key',
      organizationId: 'org',
      keyword: 'keyword',
    });
    const manual = await quotas.resolve(db as any, intent, account, 0, now);
    const automatic = await quotas.resolve(
      db as any,
      { ...intent, sendOrigin: 'AUTOMATION' },
      account,
      0,
      now
    );
    expect(
      manual.budgets.find(
        (b) => b.dimension === 'REPLY_ROOTS_PLAN' && b.scope === 'PROJECT'
      )
    ).toMatchObject({ limit: 2, enforce: true });
    expect(
      manual.budgets.find((b) => b.scope === 'PROJECT_KEYWORD')
    ).toMatchObject({ limit: 1, keyword: 'keyword' });
    expect(
      automatic.budgets.find((b) => b.dimension === 'REPLY_ROOTS_PLAN')
    ).toMatchObject({ enforce: false });
    expect(
      automatic.budgets.find((b) => b.dimension === 'REPLY_ROOTS_AUTO')
    ).toMatchObject({ enforce: true });
  });
  it('stops new automatic permits when Automation is disabled while allowing manual requests', async () => {
    const { db, quotas, intent, account } = await policy();
    db.rows('engageConfig')[0].metadata.automationEnabled = false;
    await expect(
      quotas.resolve(
        db as any,
        { ...intent, sendOrigin: 'AUTOMATION' },
        account,
        0,
        now
      )
    ).rejects.toThrow('AUTOMATION_DISABLED');
    await expect(
      quotas.resolve(db as any, intent, account, 0, now)
    ).resolves.toHaveProperty('budgets');
  });
  it.each(['AUTHORIZED','UNKNOWN'])('counts another account pending root in shared project spacing: %s', async status => {
    const {db,quotas,intent,account}=await policy();
    db.seed('sendIntent',{id:'other-intent',organizationId:'org',projectId:'project',platform:'x',action:'REPLY'});
    db.seed('sendExecution',{id:'other-account',sendIntentId:'other-intent'});
    db.seed('sendSegment',{organizationId:'org',executionId:'other-account',segmentIndex:0,status,
      authorizedAt:new Date(now.getTime()-1000),submitBefore:new Date(now.getTime()+29000)});
    await expect(quotas.resolve(db as any,{...intent,sendOrigin:'AUTOMATION'},account,0,now)).rejects.toThrow('PROJECT_REPLY_INTERVAL');
  });
  it.each(['other-project','child','stopped'])('does not block project spacing with irrelevant held work: %s', async kind => {
    const {db,quotas,intent,account}=await policy();
    db.seed('sendIntent',{id:'other-intent',organizationId:'org',projectId:kind==='other-project'?'elsewhere':'project',platform:'x',action:'REPLY'});
    db.seed('sendExecution',{id:'other-account',sendIntentId:'other-intent'});
    db.seed('sendSegment',{organizationId:'org',executionId:'other-account',segmentIndex:kind==='child'?1:0,status:kind==='stopped'?'NOT_SUBMITTED':'AUTHORIZED',authorizedAt:now,submitBefore:new Date(now.getTime()+30000)});
    await expect(quotas.resolve(db as any,{...intent,sendOrigin:'AUTOMATION'},account,0,now)).resolves.toHaveProperty('budgets');
  });
  it('retains the configured publish gap for ordinary posts and rejects an invalid account timezone', async () => {
    const { db, quotas, intent, account } = await policy();
    db.seed('settings', {
      key: 'extension_publish.min_gap',
      value: { default: 90 },
    });
    expect(
      (
        await quotas.resolve(
          db as any,
          { ...intent, action: 'POST' },
          account,
          0,
          now
        )
      ).gapMs
    ).toBe(90 * 60_000);
    await expect(
      quotas.resolve(
        db as any,
        intent,
        { ...account, timezone: 'invalid' },
        0,
        now
      )
    ).rejects.toThrow('ACCOUNT_TIMEZONE_INVALID');
  });
});

it('settles an older UNKNOWN hold included when a new quota bucket is initialized', async () => {
 const db = memorySendDatabase(); const quota = new SendQuotaService();
 db.seed('sendExecution', { id: 'old', organizationId: 'org', projectId: 'project', platform: 'x', action: 'REPLY' });
 db.seed('sendSegment', { organizationId: 'org', executionId: 'old', segmentIndex: 0, authorizedAt: now, status: 'UNKNOWN' });
 await db.$transaction((tx: any) => quota.reserve(tx, 'org', 'new', 0, [budget({ limit: 3 })], now));
 expect(db.rows('sendQuotaBucket')[0].heldUnits).toBe(2);
 await db.$transaction((tx: any) => quota.settle(tx, 'org', 'old', 0, true, now));
 expect(db.rows('sendQuotaBucket')[0]).toMatchObject({ heldUnits: 1, confirmedUnits: 1 });
});

it('includes legacy LinkedIn company roots in the canonical LinkedIn project budget', async () => {
  const db=memorySendDatabase();const quota=new SendQuotaService();
  for(const providerIdentifier of ['linkedin','linkedin-page']) db.seed('post',{
    organizationId:'org',projectId:'project',providerIdentifier,state:'PUBLISHED',publishDate:now,
    sendIntentId:null,source:'engage',parentPostId:null,
  });
  await expect(db.$transaction((tx:any)=>quota.reserve(tx,'org','new',0,[budget({platform:'linkedin',limit:2})],now))).rejects.toThrow('SEND_QUOTA_EXHAUSTED');
  expect(db.rows('sendQuotaReservation')).toHaveLength(0);
});

describe('quota continuity across organization sending modes', () => {
  it('rebuilds from controlled and autonomous facts without resetting the same-window allowance', async () => {
    const { SendModeService } = await import('../send-mode.service');
    const f = setupSend();
    await f.create();
    f.quotas.resolve.mockRestore();
    f.db.rows('userOrganization')[0].role = 'ADMIN';
    const intent = f.db.rows('sendIntent')[0];
    const account = { ...f.db.rows('accountWriteState')[0], dailyWriteLimit: 3, timezone: 'UTC' };
    const modes = new SendModeService(f.db as any);
    const save = (mode: 'CONTROLLED' | 'AUTONOMOUS', expectedRevision: number, requestId: string) => modes.save('org', 'user',
      { mode, expectedRevision, requestId, expectedOrganizationId: 'org', expectedUserId: 'user' });
    const currentBudget = async () => (await f.quotas.resolve(f.db as any, intent, account, 0, now)).budgets
      .find(row => row.dimension === 'PLATFORM_WRITES')!;
    const firstBudget = await currentBudget();
    await f.db.$transaction((tx: any) => f.quotas.reserve(tx, 'org', 'first', 0, [firstBudget], now));
    f.db.seed('sendExecution', { id: 'first', organizationId: 'org', projectId: 'project', platform: 'x', action: 'POST',
      canonicalAccountKey: account.canonicalAccountKey, sendIntentId: intent.id, status: 'CONFIRMED' });
    f.db.seed('sendSegment', { organizationId: 'org', executionId: 'first', segmentIndex: 0, status: 'CONFIRMED', authorizedAt: now });
    await f.db.$transaction((tx: any) => f.quotas.settle(tx, 'org', 'first', 0, true, now));
    intent.status = 'SUCCEEDED';
    f.db.rows('post')[0].state = 'PUBLISHED';
    await save('AUTONOMOUS', 1, 'autonomous');
    f.db.seed('post', { id: 'legacy', organizationId: 'org', integrationId: 'account', providerIdentifier: 'x',
      parentPostId: null, state: 'PUBLISHED', publishDate: now, sendIntentId: null, executionProtocol: 'LEGACY' });
    await save('CONTROLLED', 2, 'controlled-again');
    const reopenedBudget = await currentBudget();
    expect(reopenedBudget.key).not.toBe(firstBudget.key);
    await f.db.$transaction((tx: any) => f.quotas.reserve(tx, 'org', 'second', 0, [reopenedBudget], now));
    expect(f.db.rows('sendQuotaBucket').find(row => row.id === reopenedBudget.key))
      .toMatchObject({ confirmedUnits: 2, heldUnits: 1 });
    await expect(f.db.$transaction((tx: any) => f.quotas.reserve(tx, 'org', 'third', 0, [reopenedBudget], now)))
      .rejects.toThrow('SEND_QUOTA_EXHAUSTED');
    f.db.seed('sendExecution', { id: 'second', organizationId: 'org', projectId: 'project', platform: 'x', action: 'POST',
      canonicalAccountKey: account.canonicalAccountKey, sendIntentId: intent.id, status: 'CONFIRMED' });
    f.db.seed('sendSegment', { organizationId: 'org', executionId: 'second', segmentIndex: 0, status: 'CONFIRMED', authorizedAt: now });
    await f.db.$transaction((tx: any) => f.quotas.settle(tx, 'org', 'second', 0, true, now));
    await save('CONTROLLED', 3, 'same-mode-save');
    const sameModeBudget = await currentBudget();
    expect(sameModeBudget.key).not.toBe(reopenedBudget.key);
    await expect(f.db.$transaction((tx: any) => f.quotas.reserve(tx, 'org', 'fourth', 0, [sameModeBudget], now)))
      .rejects.toThrow('SEND_QUOTA_EXHAUSTED');
    expect(f.db.rows('sendQuotaReservation').some(row => row.executionId === 'fourth')).toBe(false);
  });
});

it('settles contradictory late confirmations into every mode epoch exactly once', async () => {
  const { SendModeService } = await import('../send-mode.service');
  const f = setupSend(); await f.create(); f.quotas.resolve.mockRestore();
  f.db.rows('userOrganization')[0].role = 'ADMIN';
  const intent = f.db.rows('sendIntent')[0];
  const account = { ...f.db.rows('accountWriteState')[0], dailyWriteLimit: 3, timezone: 'UTC' };
  const modes = new SendModeService(f.db as any);
  const currentBudget = async () => (await f.quotas.resolve(f.db as any, intent, account, 0, now)).budgets
    .find(row => row.dimension === 'PLATFORM_WRITES')!;
  const originalBudget = await currentBudget();
  await f.db.$transaction((tx: any) => f.quotas.reserve(tx, 'org', 'old-released', 0, [originalBudget], now));
  f.db.seed('sendExecution', { id: 'old-released', organizationId: 'org', projectId: 'project', platform: 'x', action: 'POST',
    canonicalAccountKey: account.canonicalAccountKey, sendIntentId: intent.id, status: 'FAILED_FINAL' });
  f.db.seed('sendSegment', { organizationId: 'org', executionId: 'old-released', segmentIndex: 0,
    status: 'NOT_SUBMITTED', authorizedAt: now });
  await f.db.$transaction((tx: any) => f.quotas.settle(tx, 'org', 'old-released', 0, false, now));
  intent.status = 'FAILED_FINAL'; f.db.rows('post')[0].state = 'ERROR';
  await modes.save('org', 'user', { mode: 'AUTONOMOUS', expectedRevision: 1, requestId: 'leave',
    expectedOrganizationId: 'org', expectedUserId: 'user' });
  f.db.seed('post', { id: 'autonomous-published', organizationId: 'org', integrationId: 'account', providerIdentifier: 'x',
    parentPostId: null, state: 'PUBLISHED', publishDate: now, sendIntentId: null, executionProtocol: 'LEGACY' });
  await modes.save('org', 'user', { mode: 'CONTROLLED', expectedRevision: 2, requestId: 'return',
    expectedOrganizationId: 'org', expectedUserId: 'user' });
  const reopened = await currentBudget();
  await f.db.$transaction((tx: any) => f.quotas.reserve(tx, 'org', 'current', 0, [reopened], now));
  for (let index = 0; index < 2; index++)
    await f.db.$transaction((tx: any) => f.quotas.correctLateConfirmation(tx, 'org', 'old-released', 0, now));
  expect(f.db.rows('sendQuotaBucket').find(row => row.id === reopened.key)).toMatchObject({ confirmedUnits: 2, heldUnits: 1 });
  expect(f.db.rows('sendQuotaReservation').filter(row => row.executionId === 'old-released').map(row => row.state))
    .toEqual(['COMMITTED', 'COMMITTED']);
  await expect(f.db.$transaction((tx: any) => f.quotas.reserve(tx, 'org', 'extra', 0, [reopened], now)))
    .rejects.toThrow('SEND_QUOTA_EXHAUSTED');
});

it.each([['x', 'x', 'reddit'], ['linkedin', 'linkedin-page', 'x']])(
  'charges unattributed %s writes conservatively to account quota while excluding another platform', async (platform, samePlatform, otherPlatform) => {
    const f = setupSend(); await f.create(); f.quotas.resolve.mockRestore();
    const intent = { ...f.db.rows('sendIntent')[0], platform };
    const account = { ...f.db.rows('accountWriteState')[0], dailyWriteLimit: 5, timezone: 'UTC' };
    for (const [id, integrationId, providerIdentifier, sendIntentId] of [
      ['same-platform', null, samePlatform, null], ['unknown-platform', null, null, null],
      ['blank-platform', null, '', null], ['bound-actor', 'account', platform, null],
      ['different-platform', null, otherPlatform, null], ['other-bound-actor', 'other', platform, null],
      ['controlled-post', null, platform, 'controlled-intent'],
    ]) f.db.seed('post', { id, organizationId: 'org', integrationId, providerIdentifier, sendIntentId,
      state: 'PUBLISHED', publishDate: now, parentPostId: null });
    const selected = (await f.quotas.resolve(f.db as any, intent, account, 0, now)).budgets
      .find(row => row.dimension === 'PLATFORM_WRITES')!;
    await f.db.$transaction((tx: any) => f.quotas.reserve(tx, 'org', 'one', 0, [selected], now));
    expect(f.db.rows('sendQuotaBucket').find(row => row.id === selected.key))
      .toMatchObject({ confirmedUnits: 4, heldUnits: 1 });
    await expect(f.db.$transaction((tx: any) => f.quotas.reserve(tx, 'org', 'two', 0, [selected], now)))
      .rejects.toThrow('SEND_QUOTA_EXHAUSTED');
  }
);

it('counts a recurring thread-comment release clone as a reply write and excludes it from business root quotas', async () => {
  const db = memorySendDatabase(); const quota = new SendQuotaService();
  db.seed('post', { id: 'thread-release', organizationId: 'org', projectId: 'project', providerIdentifier: 'x',
    state: 'PUBLISHED', publishDate: now, sendIntentId: null, parentPostId: null,
    sourcePostId: 'template-child', sourcePost: { parentPostId: 'template-root' }, source: 'calendar', settings: '{}' });
  await expect(db.$transaction((tx: any) => quota.reserve(tx, 'org', 'write', 0,
    [budget({ key: 'write', dimension: 'REPLY_WRITES', limit: 1 })], now))).rejects.toThrow('SEND_QUOTA_EXHAUSTED');
  await db.$transaction((tx: any) => quota.reserve(tx, 'org', 'root', 0,
    [budget({ key: 'root', dimension: 'REPLY_ROOTS_AUTO', limit: 1 })], now));
  expect(db.rows('sendQuotaBucket').find(row => row.id === 'root')).toMatchObject({ confirmedUnits: 0, heldUnits: 1 });
});


describe('autonomous side-effect quota baseline', () => {
  const sideEffectBudget = (extra: Partial<SendBudget> = {}) => budget({
    key: 'actor-budget', scope: 'ACCOUNT', dimension: 'PLATFORM_WRITES', accountKey: 'actor-key',
    projectId: undefined, ...extra,
  });
  function fixture() {
    const db = memorySendDatabase();
    db.seed('accountWriteState', { organizationId: 'org', canonicalAccountKey: 'actor-key',
      integrationId: 'actor', identityIntegrationIds: ['actor-alias'] });
    return { db, q: new SendQuotaService() };
  }
  it('does not charge a repost to reply quotas, another actor, another day, or a conditional plug that did nothing', async () => {
    const { db, q } = fixture();
    const seed = (result: Record<string, unknown>) => db.seed('sendMutationReceipt', {
      organizationId: 'org', operation: 'autonomous-side-effect', result: {
        action: 'PLUG', integrationId: 'actor', status: 'CONFIRMED', revision: 2,
        confirmedAt: now.toISOString(), quotaWriteKind: 'WRITE', quotaUnits: 1, ...result,
      },
    });
    seed({});
    seed({ quotaWriteKind: 'REPLY', integrationId: 'other-actor' });
    seed({ quotaWriteKind: 'REPLY', confirmedAt: '2026-10-14T23:59:59Z' });
    seed({ quotaWriteKind: 'REPLY', quotaUnits: 0, result: false });
    await q.reserve(db as any, 'org', 'new', 0, [sideEffectBudget({ dimension: 'REPLY_WRITES' })], now);
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({ confirmedUnits: 0, heldUnits: 1 });
  });
  it('counts successful conditional reply plugs and internal comments without treating them as project reply roots', async () => {
    const { db, q } = fixture();
    for (const action of ['PLUG', 'INTERNAL_PLUG']) db.seed('sendMutationReceipt', {
      organizationId: 'org', operation: 'autonomous-side-effect', result: {
        action, integrationId: 'actor', status: 'CONFIRMED', revision: 2,
        confirmedAt: now.toISOString(), quotaWriteKind: 'REPLY', quotaUnits: 1, result: true,
      },
    });
    await expect(q.reserve(db as any, 'org', 'new', 0,
      [sideEffectBudget({ limit: 2, dimension: 'REPLY_WRITES' })], now)).rejects.toThrow('SEND_QUOTA_EXHAUSTED');
    await q.reserve(db as any, 'org', 'business-root', 0, [budget()], now);
    expect(db.rows('sendQuotaBucket').find((row: any) => row.id === 'budget')).toMatchObject({ confirmedUnits: 0 });
  });
  it('fails closed for a confirmed plugin write whose units are not attributable', async () => {
    const { db, q } = fixture();
    db.seed('sendMutationReceipt', { organizationId: 'org', operation: 'autonomous-side-effect', result: {
      action: 'INTERNAL_PLUG', integrationId: 'actor', status: 'CONFIRMED', revision: 2,
      confirmedAt: now.toISOString(),
    } });
    await expect(q.reserve(db as any, 'org', 'new', 0, [sideEffectBudget()], now))
      .rejects.toThrow('SEND_QUOTA_BASELINE_UNRESOLVED');
  });
  it('denies an old-format receipt whose completion time cannot be established from admission time', async () => {
    const { db, q } = fixture();
    db.seed('sendMutationReceipt', { organizationId: 'org', operation: 'autonomous-side-effect',
      createdAt: new Date('2026-10-14T23:59:59Z'),
      result: { action: 'THREAD_FINISHER', integrationId: 'actor', status: 'CONFIRMED', revision: 2,
        hasResult: true, undefinedResult: true } });
    // SendMutationReceipt has no updatedAt column; the generic harness adds it.
    delete db.rows('sendMutationReceipt')[0].updatedAt;
    await expect(db.$transaction((tx: any) => q.reserve(tx, 'org', 'new', 0,
      [sideEffectBudget()], now))).rejects.toThrow('SEND_QUOTA_BASELINE_UNRESOLVED');
  });
  it('does not count the POST/COMMENT receipts a second time alongside their published rows', async () => {
    const { db, q } = fixture();
    db.seed('post', { organizationId: 'org', id: 'published', integrationId: 'actor',
      providerIdentifier: 'x', state: 'PUBLISHED', publishDate: now, source: 'calendar', settings: '{}' });
    db.seed('sendMutationReceipt', { organizationId: 'org', operation: 'autonomous-side-effect', result: {
      action: 'POST', integrationId: 'actor', status: 'CONFIRMED', revision: 2,
      confirmedAt: now.toISOString(), postIds: ['published'],
    } });
    await q.reserve(db as any, 'org', 'new', 0, [sideEffectBudget({ limit: 2 })], now);
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({ confirmedUnits: 1, heldUnits: 1 });
  });
  it.each(['PLATFORM_WRITES', 'REPLY_WRITES'])('counts a confirmed autonomous thread finisher against %s after enrollment', async dimension => {
    const { db, q } = fixture();
    db.seed('sendMutationReceipt', { organizationId: 'org', operation: 'autonomous-side-effect',
      result: { action: 'THREAD_FINISHER', integrationId: 'actor-alias', status: 'CONFIRMED', revision: 2,
        confirmedAt: now.toISOString(), quotaWriteKind: 'REPLY', quotaUnits: 1, hasResult: true, undefinedResult: true } });
    await expect(db.$transaction((tx: any) => q.reserve(tx, 'org', 'new', 0,
      [sideEffectBudget({ dimension })], now))).rejects.toThrow('SEND_QUOTA_EXHAUSTED');
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
  });
});
