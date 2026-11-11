import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { readPublishNowRequestedAt, withPublishNowRequestedAt, preserveDispatchTarget, stripDispatchTarget } from '../send-dispatch';
describe('JSON publish dispatch', () => {
  const at = new Date('2026-11-11T01:02:03.000Z');
  it('validates server priority and survives JSON round trips', () => {
    expect(readPublishNowRequestedAt(JSON.parse(JSON.stringify(withPublishNowRequestedAt(null, at))))).toEqual(at);
    for (const target of [null, {}, {dispatch:{mode:'later',requestedAt:at.toISOString()}}, {dispatch:{mode:'now',requestedAt:'bad'}}]) expect(readPublishNowRequestedAt(target)).toBeNull();
  });
  it('preserves bound identity and handover while replacing or clearing dispatch', () => {
    const target = { integrationId: 'account', handoverMode: 'CONTROLLED', dispatch: {mode:'now',requestedAt:at.toISOString()} };
    expect(withPublishNowRequestedAt(target, null)).toEqual({integrationId:'account',handoverMode:'CONTROLLED'});
    expect(preserveDispatchTarget(target, {integrationId:'other'})).toEqual({integrationId:'other',dispatch:target.dispatch});
    expect(withPublishNowRequestedAt({dispatch:target.dispatch},null)).toBe(Prisma.DbNull);
    expect(stripDispatchTarget({dispatch:target.dispatch})).toBeNull();
    expect(stripDispatchTarget(target)).toEqual({integrationId:'account',handoverMode:'CONTROLLED'});
  });
});
