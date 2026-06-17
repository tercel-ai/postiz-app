import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddKeywordDto } from '../engage.dto';

// W5 regression: keyword is trim+collapse normalised at the boundary so the
// stored value matches its global scan-unit key (which normalises the same way).
describe('AddKeywordDto.keyword normalization', () => {
  it('trims and collapses internal whitespace, preserving case', () => {
    const dto = plainToInstance(AddKeywordDto, { keyword: '  Machine   Learning ' });
    expect(dto.keyword).toBe('Machine Learning');
  });

  it('rejects an all-whitespace keyword (collapses to empty → MinLength)', async () => {
    const dto = plainToInstance(AddKeywordDto, { keyword: '   ' });
    const errors = await validate(dto as object);
    expect(errors.flatMap((e) => Object.keys(e.constraints ?? {}))).toContain('minLength');
  });
});
