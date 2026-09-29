import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  AdminBillingRecordsQueryDto,
} from '../admin-billing-records-query.dto';

// Everything reaching this DTO comes off a query string, so these tests run the
// real transform + validation pair rather than constructing the class directly.
const parse = (query: Record<string, unknown>) => {
  const dto = plainToInstance(AdminBillingRecordsQueryDto, query, {
    enableImplicitConversion: false,
  });
  return { dto, errors: validateSync(dto) };
};

const failedProps = (query: Record<string, unknown>) =>
  parse(query).errors.map((error) => error.property);

describe('AdminBillingRecordsQueryDto set parameters', () => {
  it('splits a comma-separated set into an array', () => {
    const { dto, errors } = parse({ status: 'failed,unbilled' });

    expect(errors).toHaveLength(0);
    expect(dto.status).toEqual(['failed', 'unbilled']);
  });

  // What a human pasting a list actually produces. Without the trim the second
  // element is ' unbilled', which matches no row and reports zero silently.
  it('trims the spaces a pasted list carries', () => {
    expect(parse({ status: 'failed, unbilled' }).dto.status).toEqual([
      'failed',
      'unbilled',
    ]);
  });

  it('drops empties and duplicates', () => {
    expect(parse({ scene: 'engage_reply,,engage_reply,' }).dto.scene).toEqual([
      'engage_reply',
    ]);
  });

  it('accepts a repeated query parameter as well as a comma list', () => {
    expect(parse({ subType: ['chat', 'post_gen'] }).dto.subType).toEqual([
      'chat',
      'post_gen',
    ]);
  });

  // Every sibling admin list DTO caps its set parameters; this one used to be the
  // only one without a bound, while also expanding each scene id into its own
  // multi-parameter SQL predicate.
  it('caps a set at 30 entries', () => {
    const under = Array.from({ length: 30 }, (_, i) => `s${i}`).join(',');
    const over = Array.from({ length: 31 }, (_, i) => `s${i}`).join(',');

    expect(failedProps({ scene: under })).not.toContain('scene');
    expect(failedProps({ scene: over })).toContain('scene');
  });

  // The sets are open-ended by design — a new billing call site adds to them —
  // so an unknown member must reach the compiler and narrow to nothing there.
  it('does not reject an unknown member', () => {
    expect(failedProps({ scene: 'no-such-scene' })).toHaveLength(0);
  });
});

describe('AdminBillingRecordsQueryDto bounds', () => {
  // The opposite policy from the sets: ignoring a malformed bound would answer
  // with the whole ledger AND its credit total while the operator believes they
  // are looking at a scoped window.
  it('rejects a date it cannot parse instead of ignoring it', () => {
    expect(failedProps({ dateFrom: 'last week' })).toContain('dateFrom');
    expect(failedProps({ dateTo: '2026-13-01' })).toContain('dateTo');
  });

  it('accepts the ISO strings the admin UI sends', () => {
    expect(
      failedProps({
        dateFrom: '2026-09-01',
        dateTo: '2026-09-30T23:59:59.000Z',
      })
    ).toHaveLength(0);
  });

  it('rejects an amount bound that is not a plain decimal', () => {
    expect(failedProps({ minAmount: '1,5' })).toContain('minAmount');
    expect(failedProps({ minAmount: '1e-3' })).toContain('minAmount');
    expect(failedProps({ maxAmount: ' 1 ' })).toContain('maxAmount');
  });

  it('accepts a plain decimal bound', () => {
    expect(
      failedProps({ minAmount: '0.5', maxAmount: '250' })
    ).toHaveLength(0);
  });

  it('allowlists the sort field and direction', () => {
    expect(failedProps({ sortBy: 'amount', sortOrder: 'asc' })).toHaveLength(0);
    expect(failedProps({ sortBy: 'organizationId' })).toContain('sortBy');
    expect(failedProps({ sortOrder: 'sideways' })).toContain('sortOrder');
  });

  it('caps pageSize at 200', () => {
    expect(failedProps({ pageSize: '500' })).toContain('pageSize');
    expect(failedProps({ pageSize: '200' })).toHaveLength(0);
  });
});
