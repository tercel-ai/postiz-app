import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { ConflictException } from '@nestjs/common';

export interface ControlledSubmitContext {
  authorize(): Promise<{
    granted: boolean;
    submitBefore?: string;
    serverNow?: string;
  }>;
  invoked: boolean;
  authorized: boolean;
  consumed: boolean;
}
const context = new AsyncLocalStorage<ControlledSubmitContext>();
export const currentSendContext = () => context.getStore();
export const withControlledSubmit = <T>(
  state: ControlledSubmitContext,
  work: () => Promise<T>
) => context.run(state, work);

// Wrap the actual network mutation, after uploads and immediately after a fresh actor probe.
export async function controlledSubmit<T>(work: () => Promise<T>): Promise<T> {
  const state = context.getStore();
  if (!state) return work();
  if (state.consumed)
    throw new ConflictException('SEND_PERMIT_ALREADY_CONSUMED');
  state.consumed = true;
  const started = performance.now();
  const permission = await state.authorize();
  if (!permission.granted)
    throw new ConflictException('SEND_PERMIT_NOT_GRANTED');
  state.authorized = true;
  const remaining =
    Date.parse(permission.submitBefore!) -
    Date.parse(permission.serverNow!) -
    (performance.now() - started);
  if (!Number.isFinite(remaining) || remaining < 1_000)
    throw new ConflictException('SEND_PERMIT_EXPIRED');
  // A timeout or thrown network error from this point is an unknown result.
  state.invoked = true;
  return work();
}
