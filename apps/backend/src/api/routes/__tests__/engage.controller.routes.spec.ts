import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { EngageController } from '../engage.controller';

describe('EngageController opportunity count routes', () => {
  it('passes the authenticated user and project into the editor detail read', async () => {
    const getOpportunityById = vi.fn(async () => ({ id: 'opportunity' }));
    const controller = Object.assign(Object.create(EngageController.prototype), { _engageService: { getOpportunityById } });
    const org = { id: 'org' }, user = { id: 'user' };
    await controller.getOpportunityById(org, 'opportunity', user, 'project');
    expect(getOpportunityById).toHaveBeenCalledExactlyOnceWith(org, 'opportunity', 'project', user.id);
  });
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

  it('exposes manual opportunity import at the fixed contract path, over POST', () => {
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        EngageController.prototype.manualImportOpportunity
      )
    ).toBe('/opportunities/manual-import');
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        EngageController.prototype.manualImportOpportunity
      )
    ).toBe(RequestMethod.POST);
  });
});
