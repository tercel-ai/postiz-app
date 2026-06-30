import { describe, expect, it } from 'vitest';
import { AiseeCreditService } from './aisee-credit.service';
import { AiseeClient, AiseeBusinessType } from './aisee.client';

/**
 * resolveChannel maps a deduction to its business-module channel so credit
 * consumption can be attributed to analysis (aisee-core native, not here),
 * post ('postiz'), or engage ('engage') in the aisee-core transactions ledger.
 */
describe('AiseeCreditService.resolveChannel', () => {
  it('tags engage_reply as engage', () => {
    expect(AiseeCreditService.resolveChannel(AiseeBusinessType.ENGAGE_REPLY)).toBe(
      AiseeClient.ENGAGE_CHANNEL
    );
  });

  it('tags post_overage on an engage post as engage', () => {
    expect(
      AiseeCreditService.resolveChannel(AiseeBusinessType.POST_OVERAGE, {
        source: 'engage',
      })
    ).toBe(AiseeClient.ENGAGE_CHANNEL);
  });

  it('tags post_overage on calendar/chat as postiz', () => {
    expect(
      AiseeCreditService.resolveChannel(AiseeBusinessType.POST_OVERAGE, {
        source: 'calendar',
      })
    ).toBe(AiseeClient.CHANNEL);
    expect(
      AiseeCreditService.resolveChannel(AiseeBusinessType.POST_OVERAGE)
    ).toBe(AiseeClient.CHANNEL);
  });

  it('tags post business types as postiz', () => {
    for (const bt of [
      AiseeBusinessType.AI_COPYWRITING,
      AiseeBusinessType.IMAGE_GEN,
      AiseeBusinessType.VIDEO_GEN,
      AiseeBusinessType.POST_ANALYTICS,
    ]) {
      expect(AiseeCreditService.resolveChannel(bt)).toBe(AiseeClient.CHANNEL);
    }
  });
});
