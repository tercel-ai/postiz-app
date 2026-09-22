import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ListSentDto,
  LocateSentReplyDto,
  SentCountsSummaryDto,
} from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';

async function fieldsWithErrors(
  cls: any,
  query: Record<string, unknown>
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, query) as object);
  return errors.map((e) => e.property);
}

describe('the /sent date search contract', () => {
  // The three DTOs a date control touches at once: the list, the badge rollup
  // beside it, and the page-locator behind "jump back to this reply". They have
  // to accept the same query string or the UI has to special-case one of them.
  const DTOS: [string, any][] = [
    ['ListSentDto', ListSentDto],
    ['LocateSentReplyDto', LocateSentReplyDto],
    ['SentCountsSummaryDto', SentCountsSummaryDto],
  ];

  describe.each(DTOS)('%s', (_name, cls) => {
    it('accepts a one-day search written as the same date twice', async () => {
      expect(
        await fieldsWithErrors(cls, {
          sentReplyId: 's1', // required on the locator, ignored by the others
          startDate: '2026-09-18',
          endDate: '2026-09-18',
        })
      ).toEqual([]);
    });

    it('accepts full timestamps and either bound alone', async () => {
      expect(
        await fieldsWithErrors(cls, {
          sentReplyId: 's1',
          startDate: '2026-09-18T09:30:00.000Z',
        })
      ).toEqual([]);
      expect(
        await fieldsWithErrors(cls, { sentReplyId: 's1', endDate: '2026-09-18' })
      ).toEqual([]);
    });

    it('rejects a day that does not exist rather than rolling it forward', async () => {
      // Plain @IsDateString would PASS 2026-02-30 and dayjs would read it as
      // March 2nd — the search would succeed and return the wrong day's rows.
      expect(
        await fieldsWithErrors(cls, {
          sentReplyId: 's1',
          startDate: '2026-02-30',
        })
      ).toEqual(['startDate']);
      expect(
        await fieldsWithErrors(cls, { sentReplyId: 's1', endDate: '2026-13-01' })
      ).toEqual(['endDate']);
    });

    it.each(['2026-9-8', '18/09/2026', 'yesterday', ''])(
      'rejects %j as a startDate',
      async (startDate) => {
        expect(
          await fieldsWithErrors(cls, { sentReplyId: 's1', startDate })
        ).toEqual(['startDate']);
      }
    );
  });

  it('keeps the rolling `date` preset lenient', async () => {
    // Deliberately untouched: an empty `?date=` is how the "All" toggle clears
    // the filter, and the vocabulary is shared with /dashboard/summary, so an
    // unknown word still falls through to all-time instead of 400-ing.
    for (const date of ['', 'all', 'today', 'week', 'month', 'munth']) {
      expect(await fieldsWithErrors(ListSentDto, { date })).toEqual([]);
    }
  });
});
