// The X post ceiling is a property of a CUSTOMER'S SUBSCRIPTION, and it arrives
// on the REQUEST — the web app reads it live from the browser extension over
// the social-sessions bridge and passes it down. Nothing is stored server-side,
// so there is no copy to go stale; what there is instead is a client-supplied
// number, and every test here is about not trusting it further than it goes.
//
// Getting it too high is the expensive direction — the post fills X's composer,
// the Post button never enables, and an already-paid generation is unusable.
// Getting it too low costs a shorter post and nothing else.
import { describe, expect, it } from 'vitest';

import {
  allowsLongForm,
  fitsXCeiling,
  resolveRequestedXCeiling,
  X_FREE_MAX_WEIGHTED,
  X_SUBSCRIBED_MAX_WEIGHTED,
} from '../x-account-ceiling';

describe('resolveRequestedXCeiling', () => {
  it('honours a ceiling X actually grants', () => {
    expect(resolveRequestedXCeiling(280)).toBe(280);
    expect(resolveRequestedXCeiling(25000)).toBe(25000);
    expect(resolveRequestedXCeiling(4096)).toBe(4096);
  });

  it('falls back to the free tier when the request says nothing', () => {
    // The caller is about to spend a paid generation, so this always answers a
    // usable number rather than throwing — and 280 is the ceiling every X
    // account has.
    expect(resolveRequestedXCeiling(undefined)).toBe(280);
    expect(resolveRequestedXCeiling(null)).toBe(280);
  });

  it('refuses a value outside what X is known to grant', () => {
    // Not a more generous account: a bug, a stale client, or a forged body.
    expect(resolveRequestedXCeiling(25001)).toBe(280);
    expect(resolveRequestedXCeiling(1_000_000)).toBe(280);
    expect(resolveRequestedXCeiling(279)).toBe(280);
    expect(resolveRequestedXCeiling(0)).toBe(280);
    expect(resolveRequestedXCeiling(-1)).toBe(280);
  });

  it('refuses anything that is not a finite number', () => {
    for (const bad of ['25000', {}, [], true, Number.NaN, Infinity, -Infinity]) {
      expect(resolveRequestedXCeiling(bad)).toBe(280);
    }
  });

  it('floors a fractional ceiling rather than discarding it', () => {
    // A client that computed one from a percentage should get the conservative
    // whole number, not a silent fall back to the free tier.
    expect(resolveRequestedXCeiling(4096.9)).toBe(4096);
    expect(resolveRequestedXCeiling(280.5)).toBe(280);
  });
});

describe('allowsLongForm / fitsXCeiling', () => {
  it('only calls an account long-form above X"s base ceiling', () => {
    expect(allowsLongForm(X_FREE_MAX_WEIGHTED)).toBe(false);
    expect(allowsLongForm(X_SUBSCRIBED_MAX_WEIGHTED)).toBe(true);
  });

  it('counts the way X counts, not the way String.length does', () => {
    // MEASURED: 12500 Han characters = 25000 weighted = the last draft the Post
    // button still enabled for; one more character and it never enables.
    expect(fitsXCeiling('中'.repeat(12500), X_SUBSCRIBED_MAX_WEIGHTED)).toBe(true);
    expect(fitsXCeiling('中'.repeat(12501), X_SUBSCRIBED_MAX_WEIGHTED)).toBe(false);
    // The same ceiling in Latin is twice as many characters — the whole reason
    // this cannot be a character count.
    expect(fitsXCeiling('a'.repeat(25000), X_SUBSCRIBED_MAX_WEIGHTED)).toBe(true);
    expect(fitsXCeiling('中'.repeat(140), X_FREE_MAX_WEIGHTED)).toBe(true);
    expect(fitsXCeiling('中'.repeat(141), X_FREE_MAX_WEIGHTED)).toBe(false);
  });
});
