import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OpportunityCountsDto } from '../engage.dto';

describe('OpportunityCountsDto', () => {
  it('accepts and normalizes comma-separated platform filters', async () => {
    const dto = plainToInstance(OpportunityCountsDto, { platform: 'x,reddit' });

    expect(dto.platform).toEqual(['x', 'reddit']);
    expect(await validate(dto)).toEqual([]);
  });
});
