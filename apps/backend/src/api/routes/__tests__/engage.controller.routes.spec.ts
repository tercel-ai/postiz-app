import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { EngageController } from '../engage.controller';

describe('EngageController opportunity count routes', () => {
  it('keeps the legacy counts route as an alias for the summary', () => {
    const paths = Reflect.getMetadata(
      PATH_METADATA,
      EngageController.prototype.getOpportunityCountsSummary
    );

    expect(paths).toEqual(
      expect.arrayContaining([
        '/opportunities/counts',
        '/opportunities/counts/summary',
      ])
    );
  });
});
