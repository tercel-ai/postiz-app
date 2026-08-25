import { describe, expect, it } from 'vitest';
import { deferPastDueIntoWindow } from '../extension-publish-config.service';

// Giving parked posts new slots after a switch-off.
//
// The failure this prevents: automation is switched off for a week, its queued
// posts go back to DRAFT still holding last week's slots, and the switch-on
// commits all of them at once — every publishDate already in the past, so
// publish-due hands the extension the whole week in a single poll and it posts
// them back to back. Deferral is what turns "catch up instantly" into "carry
// on from here".

const WINDOW = { windowStart: '09:00', windowEnd: '18:00' }; // 540 min, UTC
const post = (id: string, iso: string) => ({ id, publishDate: new Date(iso) });
const at = (iso: string) => new Date(iso);

describe('deferPastDueIntoWindow', () => {
  it('moves every past-due post into the future', async () => {
    const placed = deferPastDueIntoWindow(
      [post('a', '2026-08-18T10:00:00Z'), post('b', '2026-08-19T10:00:00Z')],
      [],
      WINDOW,
      30,
      at('2026-08-25T08:00:00Z')
    );

    expect(placed.size).toBe(2);
    for (const when of placed.values()) {
      expect(when.valueOf()).toBeGreaterThanOrEqual(
        at('2026-08-25T08:00:00Z').valueOf()
      );
    }
  });

  it('keeps the order the plan gave them', async () => {
    // A plan's posts are written to build on each other; re-ordering them on the
    // way out would publish the follow-up before the thing it follows up on.
    const placed = deferPastDueIntoWindow(
      [post('second', '2026-08-19T10:00:00Z'), post('first', '2026-08-18T10:00:00Z')],
      [],
      WINDOW,
      30,
      at('2026-08-25T08:00:00Z')
    );

    expect(placed.get('first')!.valueOf()).toBeLessThan(
      placed.get('second')!.valueOf()
    );
  });

  it('honours the minimum gap between the posts it places', async () => {
    const placed = deferPastDueIntoWindow(
      ['a', 'b', 'c'].map((id) => post(id, '2026-08-18T10:00:00Z')),
      [],
      WINDOW,
      30,
      at('2026-08-25T08:00:00Z')
    );

    const times = [...placed.values()].map((d) => d.valueOf()).sort();
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(30 * 60_000);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('opens at the window, not at the moment the switch was flipped', async () => {
    // 08:00 is before the window opens; the first post belongs at 09:00.
    const placed = deferPastDueIntoWindow(
      [post('a', '2026-08-18T10:00:00Z')],
      [],
      WINDOW,
      30,
      at('2026-08-25T08:00:00Z')
    );

    expect(placed.get('a')!.toISOString()).toBe('2026-08-25T09:00:00.000Z');
  });

  it('never places a post before `after`, even mid-window', async () => {
    // Switching back on at 14:00 must not schedule anything for 09:00 today —
    // that time has passed, and committing it would publish on the spot.
    const placed = deferPastDueIntoWindow(
      [post('a', '2026-08-18T10:00:00Z')],
      [],
      WINDOW,
      30,
      at('2026-08-25T14:00:00Z')
    );

    expect(placed.get('a')!.toISOString()).toBe('2026-08-25T14:00:00.000Z');
  });

  it('spills into the following days when one window cannot hold them', async () => {
    // A narrow window plus a real gap fits two a day. A week of parked posts
    // must NOT be crammed in by shrinking the gap — spreading is the point.
    const narrow = { windowStart: '09:00', windowEnd: '10:00' }; // 60 min
    const placed = deferPastDueIntoWindow(
      ['a', 'b', 'c', 'd'].map((id) => post(id, '2026-08-18T10:00:00Z')),
      [],
      narrow,
      30,
      at('2026-08-25T08:00:00Z')
    );

    const days = new Set(
      [...placed.values()].map((d) => d.toISOString().slice(0, 10))
    );
    expect(placed.size).toBe(4);
    expect(days.size).toBeGreaterThan(1);
  });

  it('does not land on a slot another post already holds', async () => {
    // Posts still in the future keep their times; a deferred post arriving on
    // top of one would publish two things at the same minute.
    const taken = at('2026-08-25T09:00:00Z');
    const placed = deferPastDueIntoWindow(
      [post('a', '2026-08-18T10:00:00Z')],
      [taken],
      WINDOW,
      30,
      at('2026-08-25T08:00:00Z')
    );

    const when = placed.get('a')!;
    expect(Math.abs(when.valueOf() - taken.valueOf())).toBeGreaterThanOrEqual(
      30 * 60_000
    );
  });

  it('places nothing when the window is empty', async () => {
    const placed = deferPastDueIntoWindow(
      [post('a', '2026-08-18T10:00:00Z')],
      [],
      { windowStart: '09:00', windowEnd: '09:00' },
      30,
      at('2026-08-25T08:00:00Z')
    );

    expect(placed.size).toBe(0);
  });

  it('places nothing when there is nothing past due', async () => {
    expect(
      deferPastDueIntoWindow([], [], WINDOW, 30, at('2026-08-25T08:00:00Z')).size
    ).toBe(0);
  });

  it('reads the window in its own timezone', async () => {
    const placed = deferPastDueIntoWindow(
      [post('a', '2026-08-18T10:00:00Z')],
      [],
      { windowStart: '09:00', windowEnd: '18:00', timezone: 'America/New_York' },
      30,
      at('2026-08-25T08:00:00Z') // 04:00 in New York — before the window opens
    );

    // 09:00 New York on 2026-08-25 = 13:00 UTC (EDT, UTC-4).
    expect(placed.get('a')!.toISOString()).toBe('2026-08-25T13:00:00.000Z');
  });

  it('still places everything when the gap is zero', async () => {
    const placed = deferPastDueIntoWindow(
      ['a', 'b'].map((id) => post(id, '2026-08-18T10:00:00Z')),
      [],
      WINDOW,
      0,
      at('2026-08-25T08:00:00Z')
    );

    expect(placed.size).toBe(2);
  });
});
