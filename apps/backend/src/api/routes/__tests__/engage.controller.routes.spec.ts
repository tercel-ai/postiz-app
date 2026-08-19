import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
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

  it('exposes reply account upsert through POST only', () => {
    const routes = Object.getOwnPropertyNames(EngageController.prototype)
      .map((name) => ({
        name,
        path: Reflect.getMetadata(PATH_METADATA, EngageController.prototype[name]),
        method: Reflect.getMetadata(METHOD_METADATA, EngageController.prototype[name]),
      }))
      .filter(({ path }) => path === '/reply-accounts/:integrationId');

    expect(routes).toEqual([
      { name: 'upsertReplyAccountSettings', method: RequestMethod.POST, path: '/reply-accounts/:integrationId' },
    ]);
  });
});
