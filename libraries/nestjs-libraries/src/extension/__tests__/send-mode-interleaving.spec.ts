import { afterEach, expect, it, vi } from 'vitest';
import { SendModeService } from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';

afterEach(() => vi.unstubAllEnvs());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('retries a stale producer snapshot after concurrent legacy settlement cleanup', async () => {
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
  const db = memorySendDatabase();
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'admin',
    role: 'ADMIN',
    disabled: false,
  });
  db.seed('post', {
    id: 'captured',
    organizationId: 'org',
    state: 'QUEUE',
    releaseId: 'lease',
    claimedAt: new Date(),
    publishDate: new Date(),
  });
  const service = new SendModeService(db);
  const owner = { expectedOrganizationId: 'org', expectedUserId: 'admin' };
  await service.save('org', 'admin', {
    ...owner,
    mode: 'CONTROLLED',
    expectedRevision: 0,
    requestId: 'switch',
  });
  db.rows('post')[0].state = 'PUBLISHED';

  // Each transaction gets an independent snapshot. The memory helper supplies
  // storage/query behavior only; its global transaction queue is not used.
  const tables = [
    'settings',
    'userOrganization',
    'post',
    'sendMutationReceipt',
    'sendIntent',
    'sendExecution',
    'sendSegment',
    'sendQuotaReservation',
    'accountWriteState',
  ];
  const producerPaused = deferred();
  const resumeProducer = deferred();
  let transactionNumber = 0;
  let generation = 0;
  let conflicts = 0;
  db.$transaction = async (work: (tx: any) => Promise<unknown>) => {
    const number = transactionNumber++;
    const snapshotGeneration = generation;
    const snapshot = memorySendDatabase();
    for (const table of tables)
      for (const row of db.rows(table)) snapshot.seed(table, row);
    const tx = new Proxy(snapshot, {
      get(target, key) {
        if (key !== '$queryRaw') return Reflect.get(target, key);
        return async (query: TemplateStringsArray, ...values: unknown[]) => {
            if (
              number === 0 &&
              values[0] === 'sending.organization_mode:org'
            ) {
              producerPaused.resolve();
              await resumeProducer.promise;
            }
            const stored = db
              .rows('settings')
              .find((row) => row.key === values[0]);
            const expected = snapshot.rows('settings').find(row => row.key === values[0]);
            // PostgreSQL refuses a row lock on a row changed since the
            // Serializable transaction snapshot. The next attempt reads anew.
            if (
              JSON.stringify(stored?.value) !== JSON.stringify(expected?.value)
            ) {
              conflicts++;
              throw Object.assign(new Error('Row changed since snapshot'), { code: 'P2034' });
            }
            return snapshot.$queryRaw(query, ...values);
        };
      },
    });
    const result = await work(tx);
    if (generation !== snapshotGeneration)
      throw Object.assign(new Error('Concurrent snapshot commit'), {
        code: 'P2034',
      });
    for (const table of tables)
      db.rows(table).splice(
        0,
        db.rows(table).length,
        ...structuredClone(snapshot.rows(table))
      );
    generation++;
    return result;
  };

  const producer = service
    .beginBrowserWrite('org', 'admin', {
      ...owner,
      requestId: 'new-write',
      platform: 'x',
      contentHash: 'a'.repeat(64),
    })
    .then(
      () => null,
      (error) => error
    );
  await producerPaused.promise;
  await expect(service.reconcilePendingTransitions()).resolves.toEqual([false]);
  resumeProducer.resolve();
  expect(await producer).toMatchObject({
    message: 'SEND_MODE_AUTONOMOUS_REQUIRED',
  });

  // The stale snapshot still held legacy settlement metadata. The mode-row
  // row lock forces a retry against the completed cleanup snapshot.
  expect(conflicts).toBe(1);
  expect((await service.get('org', 'admin')).mode).toBe('CONTROLLED');
  expect(
    db
      .rows('sendMutationReceipt')
      .filter((row) => row.operation === 'autonomous-side-effect')
  ).toHaveLength(0);
});
