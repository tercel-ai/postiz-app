import { describe, it, expect } from 'vitest';
import {
  planGroupRepair,
  bucketOf,
  humanDelta,
  type PostRow,
  type RepairOptions,
} from './repair-stale-publish-date';

const OPTS: RepairOptions = {
  minDriftMs: 2 * 60_000,
  maxDriftMs: 168 * 3_600_000,
};

const T = (iso: string) => new Date(iso);
const SCHEDULED = T('2026-09-01T10:00:00.000Z');
const SENT = T('2026-09-01T11:47:00.000Z');

function row(over: Partial<PostRow> = {}): PostRow {
  return {
    id: 'p1',
    group: 'g1',
    state: 'PUBLISHED',
    parentPostId: null,
    publishDate: SCHEDULED,
    claimedAt: null,
    intervalInDays: null,
    ...over,
  };
}

describe('planGroupRepair — the send time comes from claimedAt', () => {
  it('re-dates a post the extension took nearly two hours late', () => {
    const plan = planGroupRepair([row({ claimedAt: SENT })], OPTS);

    expect(plan).toMatchObject({
      action: 'repair',
      sentAt: SENT,
      intendedAt: SCHEDULED,
      rowIds: ['p1'],
    });
  });

  it('gives a thread’s segments the anchor’s instant', () => {
    // Only roots are ever claimed (the publish-due query is roots-only), so the
    // children have no evidence of their own — they went out with the anchor.
    const plan = planGroupRepair(
      [
        row({ id: 'anchor', claimedAt: SENT }),
        row({ id: 'c1', parentPostId: 'anchor' }),
        row({ id: 'c2', parentPostId: 'anchor' }),
      ],
      OPTS
    );

    expect(plan.action).toBe('repair');
    if (plan.action !== 'repair') return;
    expect(plan.rowIds).toEqual(['anchor', 'c1', 'c2']);
    expect(plan.sentAt).toEqual(SENT);
  });

  it('takes the LAST hand-out when a lease expired and was re-taken', () => {
    const first = T('2026-09-01T10:05:00.000Z');
    const plan = planGroupRepair(
      [
        row({ id: 'anchor', claimedAt: SENT }),
        row({ id: 'other', claimedAt: first }),
      ],
      OPTS
    );

    expect(plan.action === 'repair' && plan.sentAt).toEqual(SENT);
  });
});

describe('planGroupRepair — what it refuses', () => {
  it('never touches a group containing a recurring post', () => {
    // publishDate is the cycle clone's IDENTITY there: findOrCreateCycleClone
    // matches on (group, publishDate), so moving it would let a restarted
    // workflow create a second clone and post the content twice.
    const plan = planGroupRepair(
      [
        row({ id: 'original', state: 'QUEUE', intervalInDays: 7, claimedAt: null }),
        row({ id: 'clone', claimedAt: SENT }),
      ],
      OPTS
    );

    expect(plan).toEqual({ action: 'skip', reason: 'recurring' });
  });

  it('leaves a group with no claimedAt alone rather than guessing', () => {
    expect(planGroupRepair([row()], OPTS)).toEqual({
      action: 'skip',
      reason: 'no-evidence',
    });
  });

  it('never moves a date backwards', () => {
    const plan = planGroupRepair(
      [row({ claimedAt: T('2026-09-01T09:30:00.000Z') })],
      OPTS
    );

    expect(plan).toEqual({ action: 'skip', reason: 'not-later' });
  });

  it('ignores drift under the minimum', () => {
    const plan = planGroupRepair(
      [row({ claimedAt: T('2026-09-01T10:00:30.000Z') })],
      OPTS
    );

    expect(plan).toEqual({ action: 'skip', reason: 'below-min-drift' });
  });

  it('skips an implausibly large drift instead of writing it blind', () => {
    const plan = planGroupRepair(
      [row({ claimedAt: T('2026-10-01T10:00:00.000Z') })],
      OPTS
    );

    expect(plan).toEqual({ action: 'skip', reason: 'above-max-drift' });
  });

  it('honours a disabled ceiling', () => {
    const plan = planGroupRepair([row({ claimedAt: T('2026-10-01T10:00:00.000Z') })], {
      ...OPTS,
      maxDriftMs: 0,
    });

    expect(plan.action).toBe('repair');
  });

  it('writes only PUBLISHED rows — a QUEUE sibling is still DUE', () => {
    const plan = planGroupRepair(
      [
        row({ id: 'anchor', claimedAt: SENT }),
        row({ id: 'pending', state: 'QUEUE' }),
        row({ id: 'failed', state: 'ERROR' }),
      ],
      OPTS
    );

    expect(plan.action === 'repair' && plan.rowIds).toEqual(['anchor']);
  });
});

describe('planGroupRepair — re-running is a no-op', () => {
  it('reports nothing to write once the rows already carry the send time', () => {
    const repaired = [
      row({ id: 'anchor', publishDate: SENT, claimedAt: SENT }),
      row({ id: 'c1', parentPostId: 'anchor', publishDate: SENT }),
    ];

    // claimedAt === publishDate now, so the drift check catches it first.
    expect(planGroupRepair(repaired, OPTS)).toEqual({
      action: 'skip',
      reason: 'not-later',
    });
  });

  it('stops at nothing-to-write when a later claim matches the stored date', () => {
    // A row already repaired to a LATER re-claim: drift is positive against the
    // anchor's own publishDate only if it was not the one repaired, so this
    // pins the last guard on its own.
    const later = T('2026-09-01T12:00:00.000Z');
    const plan = planGroupRepair(
      [row({ id: 'anchor', publishDate: SCHEDULED, claimedAt: later, state: 'DRAFT' })],
      OPTS
    );

    expect(plan).toEqual({ action: 'skip', reason: 'nothing-to-write' });
  });
});

describe('reporting helpers', () => {
  it('buckets drift the way the dry-run report groups it', () => {
    expect(bucketOf(60_000)).toBe('< 5m');
    expect(bucketOf(20 * 60_000)).toBe('5m–30m');
    expect(bucketOf(90 * 60_000)).toBe('30m–2h');
    expect(bucketOf(6 * 3_600_000)).toBe('2h–12h');
    expect(bucketOf(20 * 3_600_000)).toBe('12h–24h');
    expect(bucketOf(72 * 3_600_000)).toBe('> 24h');
  });

  it('reads drift at the scale it happens to be', () => {
    expect(humanDelta(45_000)).toBe('45s');
    expect(humanDelta(20 * 60_000)).toBe('20m');
    expect(humanDelta(6 * 3_600_000)).toBe('6.0h');
    expect(humanDelta(72 * 3_600_000)).toBe('3.0d');
  });
});
