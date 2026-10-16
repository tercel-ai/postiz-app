import { describe, expect, it } from 'vitest';
import { ExtensionExecutionReadyGuard } from '../extension-execution.guard';

describe('registry-only execution rollout', () => {
  const context = (headers: Record<string, string>) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) } as any);
  it('preserves ordinary legacy execution requests', () => {
    expect(
      new ExtensionExecutionReadyGuard().canActivate(
        context({ 'x-aisee-ext-version': '1.20.7' })
      )
    ).toBe(true);
  });
  it.each([
    'x-extension-node-id',
    'x-extension-node-token',
    'x-extension-protocol-version',
  ])(
    'refuses strict execution with %s before it can lease legacy work',
    (header) => {
      expect(() =>
        new ExtensionExecutionReadyGuard().canActivate(
          context({ [header]: 'strict' })
        )
      ).toThrow('ACCOUNT_BOUND_SEND_NOT_ENABLED');
    }
  );
});
