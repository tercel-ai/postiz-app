import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

// Deterministic transaction harness; it does not model PostgreSQL SSI or unique-index contention.
export function memorySendDatabase() {
  let tables: Record<string, any[]> = {};
  let tail = Promise.resolve();
  const rows = (name: string) => (tables[name] ??= []);
  const defaults = () => ({
    id: randomUUID(),
    revision: 0,
    actorKey: '',
    resolutionRevision: 0,
    routeRevision: 0,
    contentRevision: 1,
    fencingVersion: 0,
    activeExecutionId: null,
    sendIntentId: null,
    deletedAt: null,
    releaseId: null,
    firstConfirmedAt: null,
    lastConfirmedAt: null,
    nextWriteNotBefore: null,
    hasConfirmedSegments: false,
    heldUnits: 0,
    confirmedUnits: 0,
    status: 'PENDING',
    rolloutReady: true,
    identityIntegrationIds: [],
    timezone: 'UTC',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const relation = (row: any, key: string) =>
    key === 'execution'
      ? rows('sendExecution').find((e) => e.id === row.executionId)
      : key === 'sendIntent'
      ? rows('sendIntent').find((e) => e.id === row.sendIntentId)
      : key === 'intent'
      ? rows('sendIntent').find((e) => e.id === row.sendIntentId)
      : row[key];
  function matches(row: any, where: any = {}): boolean {
    if (!row) return false;
    return Object.entries(where).every(([key, value]: [string, any]) => {
      if (value === undefined) return true;
      if (key === 'AND')
        return (Array.isArray(value) ? value : [value]).every((w) =>
          matches(row, w)
        );
      if (key === 'OR') return value.some((w: any) => matches(row, w));
      if (key === 'NOT') return !matches(row, value);
      if (
        key.includes('_') &&
        !(key in row) &&
        value &&
        typeof value === 'object'
      )
        return matches(row, value);
      let actual = relation(row, key);
      if (value === null) return actual == null;
      if (value instanceof Date) return actual?.getTime() === value.getTime();
      if (typeof value !== 'object') return actual === value;
      if (Array.isArray(value.path)) actual = value.path.reduce((current:any,part:string)=>current?.[part],actual);
      return Object.entries(value).every(([op, expected]: [string, any]) => {
        if (op === 'path') return true;
        if (op === 'equals') return JSON.stringify(actual) === JSON.stringify(expected === Prisma.JsonNull ? null : expected);
        if (op === 'startsWith') return typeof actual === 'string' && actual.startsWith(expected);
        if (op === 'in') return expected.includes(actual);
        if (op === 'notIn') return !expected.includes(actual);
        if (op === 'not') return actual !== expected;
        if (op === 'gte') return actual >= expected;
        if (op === 'lte') return actual <= expected;
        if (op === 'gt') return actual > expected;
        if (op === 'lt') return actual < expected;
        if (op === 'has') return actual?.includes(expected);
        return matches(actual, { [op]: expected });
      });
    });
  }
  function update(row: any, data: any) {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (value === Prisma.JsonNull) { row[key] = null; continue; }
      if (key === 'integration' && (value as any)?.disconnect === true) {
        row.integrationId = null;
        row.integration = null;
        continue;
      }
      row[key] =
        value && typeof value === 'object' && 'increment' in value
          ? (row[key] ?? 0) + (value as any).increment
          : value && typeof value === 'object' && 'decrement' in value
          ? (row[key] ?? 0) - (value as any).decrement
          : value;
    }
    return structuredClone(row);
  }
  function output(row: any, args: any = {}) {
    if (!row) return null;
    const result = structuredClone(row);
    for (const [key, spec] of Object.entries(args.include ?? {}))
      result[key] = output(
        relation(row, key),
        typeof spec === 'object' ? spec : {}
      );
    return result;
  }
  const db: any = new Proxy(
    {
      rows,
      identitySchema: { legacyKey: true },
      $queryRaw: async () => [
        {columns:['organizationId','providerIdentifier','identityNamespace','internalId']},
        ...(db.identitySchema.legacyKey ? [{columns:['organizationId','internalId']}] : []),
      ],
      seed: (name: string, data: any) =>
        rows(name).push({ ...defaults(), ...structuredClone(data) }),
      $transaction: async (work: Function) => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        const snapshot = structuredClone(tables);
        try {
          return await work(db);
        } catch (e) {
          tables = snapshot;
          throw e;
        } finally {
          release();
        }
      },
    },
    {
      get(target: any, name: string) {
        if (name in target) return target[name];
        const find = (args: any = {}) =>
          rows(name).filter((row) => matches(row, args.where));
        const one = (args: any) => {
          const list = find(args);
          if (args?.orderBy) {
            const [key, direction] = Object.entries(args.orderBy)[0];
            list.sort(
              (a, b) =>
                (a[key] > b[key] ? 1 : -1) * (direction === 'desc' ? -1 : 1)
            );
          }
          return output(list[0], args);
        };
        return {
          findFirst: async (args: any) => one(args),
          findUnique: async (args: any) => one(args),
          findUniqueOrThrow: async (args: any) => {
            const row = one(args);
            if (!row) throw new Error('Record not found');
            return row;
          },
          findMany: async (args: any = {}) =>
            find(args).sort((a, b) => {
              const order = args.orderBy ? (Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) : [];
              for (const item of order) {
                const [key, direction] = Object.entries(item)[0];
                if (a[key] > b[key]) return direction === 'desc' ? -1 : 1;
                if (a[key] < b[key]) return direction === 'desc' ? 1 : -1;
              }
              return 0;
            }).slice(args.skip ?? 0, args.take === undefined ? undefined : (args.skip ?? 0) + args.take)
              .map((row) => output(row, args)),
          count: async (args: any) => find(args).length,
          deleteMany: async (args: any) => {
            const removed = find(args);
            tables[name] = rows(name).filter(row => !removed.includes(row));
            return { count: removed.length };
          },
          create: async ({ data }: any) => {
            const row = {
              ...defaults(),
              ...(name === 'sendExecution' ? { status: 'RESERVED' } : {}),
              ...(name === 'integration' ? {disabled:false,inBetweenSteps:false,refreshNeeded:false} : {}),
              ...(name === 'extensionNode' ? {status:'ACTIVE',credentialVersion:1,revision:1,lastReportSequence:0,lastSeenAt:new Date()} : {}),
              ...structuredClone(Object.fromEntries(Object.entries(data).map(([key,value]) => [key, value === Prisma.JsonNull ? null : value]))),
            };
            rows(name).push(row);
            return output(row);
          },
          update: async ({ where, data }: any) => {
            const row = find({ where })[0];
            if (!row) throw new Error('Record not found');
            return update(row, data);
          },
          updateMany: async ({ where, data }: any) => {
            const list = find({ where });
            list.forEach((row) => update(row, data));
            return { count: list.length };
          },
          upsert: async ({ where, create, update: data }: any) => {
            const row = find({ where })[0];
            if (row) return update(row, data);
            if (name === 'post' && create.id && rows(name).some(row => row.id === create.id))
              throw Object.assign(new Error('Unique post identity conflict'), { code: 'P2002' });
            const next = { ...defaults(), ...structuredClone(create) };
            rows(name).push(next);
            return output(next);
          },
        };
      },
    }
  );
  return db as {
    seed(name: string, row: any): void;
    rows(name: string): any[];
  } & Record<string, any>;
}
