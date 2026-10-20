import 'reflect-metadata';
import { expect, it, vi } from 'vitest';
import { SendModeController } from '../../../../../apps/backend/src/api/routes/send-mode.controller';

it('cancels a pending transition through authenticated, revision-bound scope', async () => {
  const modes = { cancelTransition: vi.fn().mockResolvedValue({ transition: null }) };
  const controller = new SendModeController(modes as any);
  const body = {
    expectedOrganizationId: 'org', expectedUserId: 'admin',
    expectedRevision: 1, requestId: 'cancel-request',
  };
  expect(typeof (controller as any).cancelTransition).toBe('function');
  await expect((controller as any).cancelTransition({ id: 'org' }, { id: 'admin' }, body))
    .resolves.toEqual({ transition: null });
  expect(modes.cancelTransition).toHaveBeenCalledWith('org', 'admin', body);
  expect(Reflect.getMetadata('path', (controller as any).cancelTransition)).toBe('/transition/cancel');
  expect(Reflect.getMetadata('method', (controller as any).cancelTransition)).toBe(1);
});
