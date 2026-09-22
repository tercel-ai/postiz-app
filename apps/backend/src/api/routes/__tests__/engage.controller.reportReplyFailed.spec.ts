import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { EngageController } from '../engage.controller';

// The ordinary (retryable) failure report — the branch the extension calls
// for anything that is not target-gone/replies-disabled, purely so the
// backend's failure-rate stats are not blind to it. Unlike /unconfirmed and
// /removed it must never close the record or notify the user; it is a
// forward-only telemetry sink onto EngageService.reportReplyFailed.
describe('EngageController POST /sent/:id/failed', () => {
  it('is registered as POST /sent/:id/failed', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, EngageController.prototype.reportReplyFailed)
    ).toBe('/sent/:id/failed');
    expect(
      Reflect.getMetadata(METHOD_METADATA, EngageController.prototype.reportReplyFailed)
    ).toBe(RequestMethod.POST);
  });

  it('forwards org, id, platform and reason to EngageService.reportReplyFailed', async () => {
    const engageService = {
      reportReplyFailed: vi.fn(async () => ({ ok: true })),
    };
    const controller = new EngageController(
      engageService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    const org = { id: 'org1' } as any;
    const result = await controller.reportReplyFailed(org, 'sent1', {
      platform: 'reddit',
      reason: 'signed out',
    } as any);

    expect(engageService.reportReplyFailed).toHaveBeenCalledWith(
      org,
      'sent1',
      'reddit',
      'signed out'
    );
    expect(result).toEqual({ ok: true });
  });
});
