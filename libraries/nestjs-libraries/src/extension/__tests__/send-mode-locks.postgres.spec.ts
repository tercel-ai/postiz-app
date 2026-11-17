// Opt-in only. Uses a fresh disposable database on explicitly selected local PostgreSQL.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { SendModeService, SEND_MODE_SYSTEM_KEY, organizationSendModeKey } from '../send-mode.service';
import { sendTransaction } from '../send-coordination.utils';
import { SendPolicyService, SEND_ACCOUNT_POLICY_KEY } from '../send-policy.service';

const databaseUrl = process.env.SEND_MODE_LOCK_TEST_URL;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Expected concurrent lock acquisition timed out')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

const fixtureTables = [
  'Settings', 'SendModeLockTestWork', 'User', 'SystemSendPolicyMutationReceipt',
  'UserOrganization', 'Post', 'SendIntent', 'SendExecution', 'SendSegment',
  'SendQuotaReservation', 'AccountWriteState', 'SendMutationReceipt',
];
const fixtureTypes = ['State', 'Role'];
const identifier = (name: string) => Prisma.raw(`"${name}"`);

async function existingFixtureObjectsIn(tx: Prisma.TransactionClient) {
  // Include table row types too: an existing standalone type can prevent CREATE TABLE.
  const names = Prisma.join([...fixtureTables, ...fixtureTypes]);
  return tx.$queryRaw<Array<{ name: string }>>`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname IN (${names})
    UNION
    SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = current_schema() AND t.typname IN (${names})`;
}

async function createFixturesIn(tx: Prisma.TransactionClient) {
  if ((await existingFixtureObjectsIn(tx)).length)
    throw new Error('Refusing existing test tables or types; create a fresh disposable database');
  await tx.$executeRaw`CREATE TABLE "Settings" (
    "id" TEXT PRIMARY KEY, "key" TEXT NOT NULL UNIQUE,
    "type" TEXT NOT NULL DEFAULT 'string', "required" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT, "value" JSONB, "default_value" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`;
  await tx.$executeRaw`CREATE TABLE "SendModeLockTestWork" ("id" TEXT PRIMARY KEY)`;
  await tx.$executeRaw`CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "isSuperAdmin" BOOLEAN NOT NULL)`;
  await tx.$executeRaw`INSERT INTO "User" VALUES ('super', true)`;
  await tx.$executeRaw`CREATE TABLE "SystemSendPolicyMutationReceipt" (
    "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL, "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE ("userId", "requestId")
  )`;
  await tx.$executeRaw`CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN', 'SUPERADMIN')`;
  await tx.$executeRaw`CREATE TABLE "UserOrganization" (
    "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false, "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE ("userId", "organizationId")
  )`;
  await tx.$executeRaw`INSERT INTO "UserOrganization" ("id", "userId", "organizationId", "role")
    VALUES ('membership', 'admin', 'a', 'ADMIN')`;
  // Minimal real tables for the existing full stateIn recovery queries.
  await tx.$executeRaw`CREATE TYPE "State" AS ENUM ('QUEUE', 'PUBLISHED', 'ERROR', 'DRAFT')`;
  await tx.$executeRaw`CREATE TABLE "Post" (
    "id" TEXT PRIMARY KEY, "organizationId" TEXT, "state" "State", "deletedAt" TIMESTAMP,
    "sendIntentId" TEXT, "executionProtocol" TEXT, "source" TEXT, "releaseId" TEXT, "claimedAt" TIMESTAMP
  )`;
  for (const name of ['SendIntent', 'SendExecution', 'SendSegment'])
    await tx.$executeRaw`CREATE TABLE ${identifier(name)} ("id" TEXT PRIMARY KEY, "organizationId" TEXT, "status" TEXT)`;
  await tx.$executeRaw`CREATE TABLE "SendQuotaReservation" ("id" TEXT PRIMARY KEY, "organizationId" TEXT, "state" TEXT)`;
  await tx.$executeRaw`CREATE TABLE "AccountWriteState" ("id" TEXT PRIMARY KEY, "organizationId" TEXT, "activeExecutionId" TEXT)`;
  await tx.$executeRaw`CREATE TABLE "SendMutationReceipt" (
    "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "userId" TEXT NOT NULL, "operation" TEXT NOT NULL,
    "requestId" TEXT NOT NULL, "requestHash" TEXT NOT NULL, "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("organizationId", "userId", "operation", "requestId")
  )`;
}

async function dropFixturesIn(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`DROP TABLE IF EXISTS ${Prisma.join(fixtureTables.map(identifier))}`;
  await tx.$executeRaw`DROP TYPE IF EXISTS ${Prisma.join(fixtureTypes.map(identifier))}`;
}

// Lifecycle regressions use a separate, transaction-owned schema inside the same
// disposable database. Rollback also removes it if a regression assertion fails.
async function withFixtureSchema(db: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<void>) {
  const schema = identifier(`fixture_${randomUUID().replace(/-/g, '')}`);
  await db.$transaction(async tx => {
    await tx.$executeRaw`CREATE SCHEMA ${schema}`;
    await tx.$executeRaw`SET LOCAL search_path TO ${schema}`;
    await work(tx);
    await tx.$executeRaw`DROP SCHEMA ${schema}`;
  }, { timeout: 10000 });
}

describe.skipIf(!databaseUrl)('sending mode locks on disposable PostgreSQL database', () => {
  let db: PrismaClient;
  let modes: SendModeService;
  let created = false;
  const transaction = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 });
  const waitForBlocked = async (pid: number) => {
    while (true) {
      const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ${pid}::integer AND NOT granted) AS waiting`;
      if (rows[0].waiting) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };

  afterEach(() => vi.restoreAllMocks());

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const disposable = /^\/aisee_mode_lock_test_[a-f0-9]{32}$/.test(url.pathname) && url.port === '5432';
    if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !disposable || url.hash ||
        [...url.searchParams.keys()].some(key => key !== 'sslmode'))
      throw new Error('Use a generated aisee_mode_lock_test_<uuid> database on local port 5432 only');
    db = new PrismaClient({ datasources: { db: { url: url.href } } });
    const target = await db.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    if (target[0].database !== url.pathname.slice(1)) throw new Error('Unexpected database target');
    // Atomic DDL: failed setup rolls back every object. Teardown owns nothing
    // until the entire fixture transaction has committed.
    await db.$transaction(createFixturesIn);
    created = true;
    modes = new SendModeService(db as any);
  });

  beforeEach(async () => {
    if (!created) return;
    await db.$executeRaw`DELETE FROM "SendModeLockTestWork"`;
    await db.systemSendPolicyMutationReceipt.deleteMany();
    await db.sendMutationReceipt.deleteMany();
    await db.post.deleteMany();
    await db.settings.deleteMany();
    await db.settings.createMany({ data: [
      { key: SEND_MODE_SYSTEM_KEY, type: 'object', value: { enabled: true, revision: 1 } },
      ...['a', 'b'].map(org => ({ key: organizationSendModeKey(org), type: 'object', value: { mode: 'CONTROLLED', revision: 1 } })),
    ] });
  });

  afterAll(async () => {
    try {
      if (created) {
        await db.$transaction(dropFixturesIn);
        created = false;
      }
    }
    finally { await db?.$disconnect(); }
  });

  it('refuses every existing fixture table or type without modifying it', async () => {
    for (const name of [...fixtureTables, ...fixtureTypes]) {
      await withFixtureSchema(db, async tx => {
        const isType = fixtureTypes.includes(name);
        if (isType) await tx.$executeRaw`CREATE TYPE ${identifier(name)} AS ENUM ('existing')`;
        else {
          await tx.$executeRaw`CREATE TABLE ${identifier(name)} ("id" TEXT PRIMARY KEY)`;
          await tx.$executeRaw`INSERT INTO ${identifier(name)} VALUES ('existing')`;
        }
        await expect(createFixturesIn(tx)).rejects.toThrow('Refusing existing test tables or types');
        expect(await existingFixtureObjectsIn(tx)).toEqual([{ name }]);
        if (isType) await tx.$executeRaw`DROP TYPE ${identifier(name)}`;
        else {
          expect(await tx.$queryRaw`SELECT "id" FROM ${identifier(name)}`).toEqual([{ id: 'existing' }]);
          await tx.$executeRaw`DROP TABLE ${identifier(name)}`;
        }
      });
    }
  });

  it('cleans every fixture after a test failure and can initialize again', async () => {
    await withFixtureSchema(db, async tx => {
      await createFixturesIn(tx);
      await expect((async () => {
        try { throw new Error('simulated test failure'); }
        finally { await dropFixturesIn(tx); }
      })()).rejects.toThrow('simulated test failure');
      expect(await existingFixtureObjectsIn(tx)).toEqual([]);
      await createFixturesIn(tx);
      await dropFixturesIn(tx);
      expect(await existingFixtureObjectsIn(tx)).toEqual([]);
    });
  });

  it('rolls back fixture setup before ownership is established if setup fails', async () => {
    const schema = `fixture_${randomUUID().replace(/-/g, '')}`;
    await expect(db.$transaction(async tx => {
      await tx.$executeRaw`CREATE SCHEMA ${identifier(schema)}`;
      await tx.$executeRaw`SET LOCAL search_path TO ${identifier(schema)}`;
      await createFixturesIn(tx);
      throw new Error('simulated setup failure');
    })).rejects.toThrow('simulated setup failure');
    expect(await db.$queryRaw`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`).toEqual([]);
  });

  it('allows independent mode guards to coexist while their transactions remain open', async () => {
    const held = deferred();
    const release = deferred();
    const first = transaction(async tx => {
      await modes.assertControlledIn(tx, 'a');
      await tx.$executeRaw`INSERT INTO "SendModeLockTestWork" ("id") VALUES ('first')`;
      held.resolve();
      await release.promise;
    });
    await within(held.promise);
    try {
      await within(Promise.all(Array.from({ length: 8 }, (_, i) => transaction(async tx => {
        await modes.assertControlledIn(tx, i % 2 ? 'a' : 'b');
        await tx.$executeRaw`INSERT INTO "SendModeLockTestWork" ("id") VALUES (${`work-${i}`})`;
      }))));
    } finally { release.resolve(); await first; }
  });

  it('holds an organization switch behind its readers while other organizations proceed', async () => {
    const held = deferred();
    const release = deferred();
    const first = transaction(async tx => {
      await modes.assertControlledIn(tx, 'a'); held.resolve(); await release.promise;
    });
    await within(held.promise);
    const started = deferred();
    let pid!: number;
    const writer = transaction(async tx => {
      const backend = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      pid = backend[0].pid;
      started.resolve();
      // The production organization-mode mutation obtains write intent before reading.
      await (modes as any).lockRowsIn(tx, 'a', true);
      await tx.settings.update({ where: { key: organizationSendModeKey('a') },
        data: { value: { mode: 'AUTONOMOUS', revision: 2 } } });
    });
    try {
      await within(started.promise);
      await within(waitForBlocked(pid));
      await within(transaction(tx => modes.assertControlledIn(tx, 'b')));
      expect((await db.settings.findUniqueOrThrow({ where: { key: organizationSendModeKey('a') } })).value)
        .toEqual({ mode: 'CONTROLLED', revision: 1 });
    } finally { release.resolve(); await first; await writer; }
    expect((await db.settings.findUniqueOrThrow({ where: { key: organizationSendModeKey('a') } })).value)
      .toEqual({ mode: 'AUTONOMOUS', revision: 2 });
  });

  it('rejects a reader with a stale system snapshot after disable commits', async () => {
    const held = deferred();
    const release = deferred();
    const readerStarted = deferred();
    const writer = transaction(async tx => {
      await (modes as any).lockSettingIn(tx, SEND_MODE_SYSTEM_KEY, true);
      await tx.settings.update({ where: { key: SEND_MODE_SYSTEM_KEY }, data: { value: { enabled: false, revision: 2 } } });
      held.resolve(); await release.promise;
    });
    await within(held.promise);
    let attempts = 0;
    const reader = sendTransaction(db, async tx => {
      attempts++;
      // Establish the old snapshot deterministically before releasing the writer.
      await tx.settings.findUnique({ where: { key: SEND_MODE_SYSTEM_KEY } });
      readerStarted.resolve();
      return modes.assertControlledIn(tx, 'a');
    }, { backoffOnConflict: true });
    const result = expect(reader).rejects.toThrow('SEND_MODE_CONTROLLED_REQUIRED');
    try { await within(readerStarted.promise); }
    finally { release.resolve(); await writer; }
    await result;
    expect(attempts).toBeGreaterThan(1);
  });

  it('reproduces the original cross-organization conflict with the old no-op update lock', async () => {
    // Exact former lock algorithm; only this control test replaces the guard.
    vi.spyOn(modes as any, 'lockSettingIn').mockImplementation(async (tx: any, key: string) => {
      const row = await tx.settings.findUniqueOrThrow({ where: { key } });
      const value = row.value === null ? Prisma.JsonNull : row.value;
      await tx.settings.updateMany({ where: { key, value: { equals: value } },
        data: { value, updatedAt: row.updatedAt } });
    });
    const held = deferred();
    const release = deferred();
    const first = transaction(async tx => {
      await modes.assertControlledIn(tx, 'a'); held.resolve(); await release.promise;
    });
    await within(held.promise);
    const started = deferred();
    let pid!: number;
    const second = transaction(async tx => {
      const backend = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      pid = backend[0].pid; started.resolve();
      return modes.assertControlledIn(tx, 'b');
    }).then(() => null, error => error);
    try {
      await within(started.promise);
      await within(waitForBlocked(pid));
    } finally { release.resolve(); await first; }
    expect(await second).toMatchObject({ code: 'P2034' });
  });

  it('allows independent policy readers to coexist without rewriting policy', async () => {
    await db.settings.create({ data: { key: SEND_ACCOUNT_POLICY_KEY, type: 'object',
      value: { mode: 'OPTIONAL', revision: 1, lastRequiredRevision: 0 } } });
    const policies = new SendPolicyService(db as any);
    const before = await db.settings.findUniqueOrThrow({ where: { key: SEND_ACCOUNT_POLICY_KEY } });
    const held = deferred();
    const release = deferred();
    const first = transaction(async tx => {
      await policies.lockSystemInTransaction(tx); held.resolve(); await release.promise;
    });
    await within(held.promise);
    try {
      await within(Promise.all(Array.from({ length: 8 }, () => transaction(tx => policies.lockSystemInTransaction(tx)))));
    } finally { release.resolve(); await first; }
    expect(await db.settings.findUniqueOrThrow({ where: { key: SEND_ACCOUNT_POLICY_KEY } })).toEqual(before);
  });

  it('keeps a real policy mutation behind active binding readers and records its tightening barrier', async () => {
    await db.settings.create({ data: { key: SEND_ACCOUNT_POLICY_KEY, type: 'object',
      value: { mode: 'OPTIONAL', revision: 1, lastRequiredRevision: 0 } } });
    const policies = new SendPolicyService(db as any);
    const held = deferred(), release = deferred(), started = deferred();
    const first = transaction(async tx => {
      await policies.lockSystemInTransaction(tx); held.resolve(); await release.promise;
    });
    await within(held.promise);
    let pid!: number;
    // Instrument only the connection PID; the actual saveSystem transaction,
    // permissions, exclusive lock, version check and receipt all execute unchanged.
    const writerPolicies = new SendPolicyService({ $transaction: (work: any, options: any) =>
      db.$transaction(async tx => {
        const backend = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        pid = backend[0].pid; started.resolve(); return work(tx);
      }, options) } as any);
    const writer = writerPolicies.saveSystem('super', {
      value: { mode: 'REQUIRED' }, expectedRevision: 1, requestId: 'tighten',
    });
    try {
      await within(started.promise);
      await within(waitForBlocked(pid));
      expect(await policies.getSystem()).toMatchObject({ mode: 'OPTIONAL', revision: 1 });
    } finally { release.resolve(); await first; }
    expect((await writer).value).toEqual({ mode: 'REQUIRED', revision: 2, lastRequiredRevision: 2 });
    expect(await db.systemSendPolicyMutationReceipt.count()).toBe(1);
  });

  it('rechecks a stale binding snapshot after REQUIRED then OPTIONAL and preserves the barrier', async () => {
    await db.settings.create({ data: { key: SEND_ACCOUNT_POLICY_KEY, type: 'object',
      value: { mode: 'OPTIONAL', revision: 1, lastRequiredRevision: 0 } } });
    const policies = new SendPolicyService(db as any);
    const ready = deferred(), resume = deferred();
    let attempts = 0;
    const reader = sendTransaction(db, async tx => {
      attempts++;
      await policies.getSystem(tx); ready.resolve(); await resume.promise;
      const policy = await policies.lockSystemInTransaction(tx);
      return { policy, requiresPreselection: policies.requiresPreselection(
        { policyRevision: 1, requirePreselectedAccount: false }, policy) };
    }, { backoffOnConflict: true });
    const result = expect(reader).resolves.toEqual({
      policy: { mode: 'OPTIONAL', revision: 3, lastRequiredRevision: 2 }, requiresPreselection: true,
    });
    try {
      await within(ready.promise);
      await policies.saveSystem('super', { value: { mode: 'REQUIRED' }, expectedRevision: 1, requestId: 'tighten' });
      await policies.saveSystem('super', { value: { mode: 'OPTIONAL' }, expectedRevision: 2, requestId: 'relax' });
    } finally { resume.resolve(); }
    await result;
    expect(attempts).toBeGreaterThan(1);
  });

  it('commits independent draft inserts with the narrow locked mode context', async () => {
    const ready = deferred();
    const release = deferred();
    let arrived = 0;
    const insert = (id: string) => transaction(async tx => {
      expect((await modes.lockModeIn(tx, 'a')).mode).toBe('CONTROLLED');
      if (++arrived === 2) ready.resolve();
      await release.promise;
      await tx.$executeRaw`INSERT INTO "Post" ("id", "organizationId", "state", "executionProtocol")
        VALUES (${id}, 'a', 'DRAFT', 'ACCOUNT_BOUND_V1')`;
    }).then(() => null, error => error);
    const both = Promise.all([insert('plan-a'), insert('plan-b')]);
    try { await within(ready.promise); }
    finally { release.resolve(); }
    const outcomes = await both;
    expect(outcomes).toEqual([null, null]);
  });

  it.each([
    ['AUTHORIZED', 'settlement'], ['AUTHORIZED', 'recovery'],
    ['UNKNOWN', 'settlement'], ['UNKNOWN', 'recovery'],
  ] as const)(
    'rechecks the same %s receipt after a real concurrent conflict when %s commits first', async (initialStatus, winner) => {
      const initial = {
        status: initialStatus, revision: 1, source: 'BROWSER', action: 'COMMENT',
        platform: 'x', browserUserId: 'admin', integrationId: 'browser:admin:x',
        quotaWriteKind: 'REPLY', quotaUnits: 1,
      };
      const receipt = await db.sendMutationReceipt.create({ data: {
        organizationId: 'a', userId: 'admin', operation: 'autonomous-side-effect',
        requestId: 'original', requestHash: 'original-hash', result: initial,
      } });
      const owner = { expectedOrganizationId: 'a', expectedUserId: 'admin' };
      const resolution = {
        ...owner, requestId: 'recover', expectedRevision: 1, decision: 'NOT_SUBMITTED' as const,
        executorStopped: true as const, noPendingSubmit: true as const,
        evidence: 'Isolated test evidence: executor stopped and platform checked.',
      };
      const outcome = { ...owner, status: 'CONFIRMED' as const,
        platformPostId: 'remote', url: 'https://x.com/test/status/123' };
      const gated = () => {
        const ready = deferred(), release = deferred();
        let attempts = 0;
        const conflicts: string[] = [];
        // Pause only the first attempt immediately before its actual receipt CAS.
        // The services, authorization, queries, writes and retry policy are real.
        const service = new SendModeService({ $transaction: (work: any, options: any) =>
          db.$transaction(async tx => {
            const firstAttempt = ++attempts === 1;
            const receipts = new Proxy(tx.sendMutationReceipt, { get(target, key) {
              if (key !== 'updateMany') return Reflect.get(target, key);
              return async (args: Prisma.SendMutationReceiptUpdateManyArgs) => {
                if (firstAttempt) { ready.resolve(); await release.promise; }
                return target.updateMany(args);
              };
            } });
            return work(new Proxy(tx, { get(target, key) {
              return key === 'sendMutationReceipt' ? receipts : Reflect.get(target, key);
            } }));
          }, options).catch(error => { conflicts.push(error.code); throw error; }) } as any);
        return { service, ready, release, conflicts, attempts: () => attempts };
      };
      const settlement = gated(), recovery = gated();
      // Reflect rejections immediately; an expected loser cannot become an unhandled rejection.
      const settle = settlement.service.settleBrowserWrite('a', 'admin', receipt.id, outcome)
        .then(value => ({ value }), error => ({ error }));
      const recover = recovery.service.resolveAutonomousEffect('a', 'admin', receipt.id, resolution)
        .then(value => ({ value }), error => ({ error }));
      let settled: Awaited<typeof settle>, recovered: Awaited<typeof recover>;
      try {
        await within(Promise.all([settlement.ready.promise, recovery.ready.promise]));
        const first = winner === 'settlement' ? settlement : recovery;
        first.release.resolve();
        const firstResult = winner === 'settlement' ? await within(settle) : await within(recover);
        expect(firstResult).toHaveProperty('value');
      } finally {
        settlement.release.resolve(); recovery.release.resolve();
        [settled, recovered] = await Promise.all([settle, recover]);
      }
      const loser = winner === 'settlement' ? recovered! : settled!;
      expect(loser).toHaveProperty('error');
      if (!('error' in loser)) throw new Error('Expected a conflicting outcome to be rejected');
      expect(loser.error.message).toBe(winner === 'settlement'
        ? 'AUTONOMOUS_EFFECT_REVISION_CONFLICT' : 'BROWSER_WRITE_OUTCOME_CONFLICT');
      expect((winner === 'settlement' ? recovery : settlement).attempts()).toBeGreaterThan(1);
      expect((winner === 'settlement' ? recovery : settlement).conflicts).toContain('P2034');
      const stored = await db.sendMutationReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
      expect(stored.requestId).toBe('original');
      expect(stored.requestHash).toBe('original-hash');
      expect(stored.result).toMatchObject({ ...initial, revision: 2,
        status: winner === 'settlement' ? 'CONFIRMED' : 'NOT_SUBMITTED' });
      if (winner === 'settlement') {
        expect(stored.result).toHaveProperty('result', { postId: 'remote', url: outcome.url });
        expect(await db.sendMutationReceipt.count({ where: { operation: 'autonomous-effect-resolution' } })).toBe(0);
        // Repeated settlement stays idempotent and cannot re-authorize platform work.
        await modes.settleBrowserWrite('a', 'admin', receipt.id, outcome);
      } else {
        expect(stored.result).toHaveProperty('evidence', resolution.evidence);
        expect(stored.result).not.toHaveProperty('confirmedAt');
        expect(await db.sendMutationReceipt.count({ where: { operation: 'autonomous-effect-resolution' } })).toBe(1);
        // Retrying the recovery request returns its original durable receipt.
        await modes.resolveAutonomousEffect('a', 'admin', receipt.id, resolution);
      }
      expect((await db.sendMutationReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).result).toEqual(stored.result);
      expect(await db.sendMutationReceipt.count()).toBe(winner === 'settlement' ? 1 : 2);
    });
});
