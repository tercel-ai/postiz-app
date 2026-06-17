import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MetricsBackfillDto } from '../metrics-backfill.dto';

function keys(errs: any[]): string[] {
  return errs.flatMap((e) => [
    ...Object.keys(e.constraints ?? {}),
    ...keys(e.children ?? []),
  ]);
}

const point = { total: 1, date: 'd' };
const series = (n: number) => ({
  label: 'likes',
  data: Array.from({ length: n }, () => point),
});

// W6 regression: nested analytics[]/data[] arrays must be bounded, not just the
// top-level items[] (extension-submitted body is an external trust boundary).
describe('MetricsBackfillDto nested array caps', () => {
  it('accepts a reasonable nested payload', async () => {
    const dto = plainToInstance(MetricsBackfillDto, {
      items: [{ postId: 'p1', analytics: [series(3)] }],
    });
    expect(keys(await validate(dto as object))).toEqual([]);
  });

  it('rejects an oversized data[] series (>64)', async () => {
    const dto = plainToInstance(MetricsBackfillDto, {
      items: [{ postId: 'p1', analytics: [series(65)] }],
    });
    expect(keys(await validate(dto as object))).toContain('arrayMaxSize');
  });

  it('rejects an oversized analytics[] list (>32)', async () => {
    const dto = plainToInstance(MetricsBackfillDto, {
      items: [{ postId: 'p1', analytics: Array.from({ length: 33 }, () => series(1)) }],
    });
    expect(keys(await validate(dto as object))).toContain('arrayMaxSize');
  });
});
