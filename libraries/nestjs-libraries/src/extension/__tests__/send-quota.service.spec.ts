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
