import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminEngageQueryDto } from '../admin-engage-query.dto';

async function parse(payload: Record<string, unknown>) {
  const dto = plainToInstance(AdminEngageQueryDto, payload);
  const errors = await validate(dto as object, { whitelist: false });
  return { dto, errors };
}

// `repliesDisabled` is the only tri-state filter on this query, and everything
// worth pinning about it comes from that: a query string carries strings, so the
// three states have to survive the round trip as true / false / undefined
// without any of them collapsing into another.
describe('AdminEngageQueryDto.repliesDisabled', () => {
  it('reads "true" as the closed-posts filter', async () => {
    const { dto, errors } = await parse({ repliesDisabled: 'true' });
    expect(errors).toEqual([]);
    expect(dto.repliesDisabled).toBe(true);
  });

  it('reads "false" as the open-posts filter, NOT as absent', async () => {
    const { dto, errors } = await parse({ repliesDisabled: 'false' });
    expect(errors).toEqual([]);
    expect(dto.repliesDisabled).toBe(false);
  });

  it('accepts 1/0, which is what a plain checkbox tends to send', async () => {
    expect((await parse({ repliesDisabled: '1' })).dto.repliesDisabled).toBe(true);
    expect((await parse({ repliesDisabled: '0' })).dto.repliesDisabled).toBe(false);
  });

  it('leaves the filter off when omitted or blank', async () => {
    // Blank is what an antd Select sends when the operator clears it, so it has
    // to mean "no filter" rather than 400-ing on an empty query string.
    expect((await parse({})).dto.repliesDisabled).toBeUndefined();
    const { dto, errors } = await parse({ repliesDisabled: '' });
    expect(errors).toEqual([]);
    expect(dto.repliesDisabled).toBeUndefined();
  });

  it('REJECTS a value it does not recognise rather than coercing it', async () => {
    // The whole reason for the explicit transform. The `value === 'true'`
    // shorthand used by the boolean flags elsewhere would read this as `false`
    // and answer "only the open posts" — the opposite of the question, with a
    // 200 and a plausible-looking page to hide it.
    const { errors } = await parse({ repliesDisabled: 'yes' });
    expect(errors.length).toBeGreaterThan(0);
  });
});
