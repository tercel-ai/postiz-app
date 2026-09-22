import { describe, expect, it } from 'vitest';
import { engageDateWindow } from '@gitroom/nestjs-libraries/engage/engage-date-window';

const iso = (d?: Date) => d?.toISOString();

describe('engageDateWindow', () => {
  describe('no window', () => {
    it.each([undefined, '', 'all', 'munth'])(
      'date=%j returns an empty filter (all-time)',
      (date) => {
        expect(engageDateWindow({ date })).toEqual({});
      }
    );

    it('returns an empty filter when called with nothing at all', () => {
      expect(engageDateWindow()).toEqual({});
    });
  });

  describe('rolling presets', () => {
    it.each(['day', 'today', 'week', 'month'])(
      'date=%s sets an open-ended lower bound',
      (date) => {
        const { publishDate } = engageDateWindow({ date });
        expect(publishDate!.gte).toBeInstanceOf(Date);
        // Open-ended by design: a preset means "recent", and a future-dated
        // QUEUE reply must stay visible inside it.
        expect(publishDate!.lt).toBeUndefined();
        expect(publishDate!.lte).toBeUndefined();
      }
    );
  });

  describe('exact bounds', () => {
    it('startDate=endDate=the same day is exactly that UTC day', () => {
      const { publishDate } = engageDateWindow({
        startDate: '2026-09-18',
        endDate: '2026-09-18',
      });

      // Half-open [18th 00:00Z, 19th 00:00Z): the whole day, once.
      expect(iso(publishDate!.gte)).toBe('2026-09-18T00:00:00.000Z');
      expect(iso(publishDate!.lt)).toBe('2026-09-19T00:00:00.000Z');
      expect(publishDate!.lte).toBeUndefined();
    });

    it('spans a multi-day range inclusively at both ends', () => {
      const { publishDate } = engageDateWindow({
        startDate: '2026-09-01',
        endDate: '2026-09-30',
      });

      expect(iso(publishDate!.gte)).toBe('2026-09-01T00:00:00.000Z');
      // The 30th is IN the range — the bound is the next midnight, not the 30th's.
      expect(iso(publishDate!.lt)).toBe('2026-10-01T00:00:00.000Z');
    });

    it('keeps a full timestamp as an exact cutoff, with no day rounding', () => {
      const { publishDate } = engageDateWindow({
        startDate: '2026-09-18T09:30:00.000Z',
        endDate: '2026-09-18T17:45:00.000Z',
      });

      expect(iso(publishDate!.gte)).toBe('2026-09-18T09:30:00.000Z');
      // `lte` (not `lt`) — an explicit instant is honoured as written.
      expect(iso(publishDate!.lte)).toBe('2026-09-18T17:45:00.000Z');
      expect(publishDate!.lt).toBeUndefined();
    });

    it('accepts either bound on its own', () => {
      expect(iso(engageDateWindow({ startDate: '2026-09-18' }).publishDate!.gte)).toBe(
        '2026-09-18T00:00:00.000Z'
      );
      const endOnly = engageDateWindow({ endDate: '2026-09-18' }).publishDate!;
      expect(endOnly.gte).toBeUndefined();
      expect(iso(endOnly.lt)).toBe('2026-09-19T00:00:00.000Z');
    });

    it('lets startDate override the preset rather than intersecting it', () => {
      const { publishDate } = engageDateWindow({
        date: 'month',
        startDate: '2020-01-15',
      });

      // The explicit instruction wins outright — a `month` preset ANDed in
      // would make a back-dated search silently return nothing.
      expect(iso(publishDate!.gte)).toBe('2020-01-15T00:00:00.000Z');
    });

    it('still applies the preset lower bound when only endDate is given', () => {
      const { publishDate } = engageDateWindow({
        date: 'month',
        endDate: '2026-09-18',
      });

      expect(publishDate!.gte).toBeInstanceOf(Date);
      expect(iso(publishDate!.lt)).toBe('2026-09-19T00:00:00.000Z');
    });
  });

  describe('unparseable bounds', () => {
    // The DTOs reject these with @IsDateString({ strict: true }), so this is the
    // internal-caller path: drop the bound rather than hand Prisma an Invalid
    // Date, which fails at the driver with an opaque error.
    it.each(['2026-02-30', '2026-13-01', '2026-9-8', 'yesterday', ''])(
      'drops startDate=%j instead of emitting an Invalid Date',
      (startDate) => {
        expect(engageDateWindow({ startDate })).toEqual({});
      }
    );

    it('never rolls a non-existent day forward to a real one', () => {
      // dayjs is lenient by default: dayjs.utc('2026-02-30') is "valid" and
      // means March 2nd. Strict parsing is what stops a search for a day that
      // does not exist from answering with another day's replies.
      expect(engageDateWindow({ endDate: '2026-02-30' })).toEqual({});
    });
  });
});
