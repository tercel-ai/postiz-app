import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OpportunityCountsSummaryDto } from '../engage.dto';

// Guards that the multi-value Transform decorators survive the OmitType
// derivation from ListOpportunitiesDto.
describe('OpportunityCountsSummaryDto', () => {
  it('accepts and normalizes comma-separated channel filters', async () => {
    const dto = plainToInstance(OpportunityCountsSummaryDto, {
      channels: 'SEO,TECH',
    });

    expect(dto.channels).toEqual(['SEO', 'TECH']);
    expect(await validate(dto)).toEqual([]);
  });
});
