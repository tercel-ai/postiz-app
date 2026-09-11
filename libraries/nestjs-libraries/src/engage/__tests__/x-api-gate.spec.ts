import { afterEach, describe, expect, it } from 'vitest';
import {
  X_API_ENABLED_ENV,
  xApiDisabledReason,
  xApiEnabled,
} from '../x-api-gate';

// This switch is the one place in the X inventory that fails CLOSED. Every other
// X toggle defaults on and turns off only when explicitly set, so an unset or
// misspelt variable there means "call the X API from a datacentre IP" — the one
// outcome that is not recoverable, because the account carries it. These tests
// exist to make that inversion hard to undo by accident.

const saved = process.env[X_API_ENABLED_ENV];

afterEach(() => {
  if (saved === undefined) delete process.env[X_API_ENABLED_ENV];
  else process.env[X_API_ENABLED_ENV] = saved;
});

describe('xApiEnabled', () => {
  it('is OFF when the variable is not set at all', () => {
    delete process.env[X_API_ENABLED_ENV];
    expect(xApiEnabled()).toBe(false);
  });

  it.each([['true'], ['TRUE'], ['True'], ['  true  '], ['1'], ['yes'], ['YES']])(
    'accepts %o as an explicit opt-in',
    (value) => {
      process.env[X_API_ENABLED_ENV] = value;
      expect(xApiEnabled()).toBe(true);
    }
  );

  it.each([
    [''],
    ['   '],
    ['false'],
    ['FALSE'],
    ['0'],
    ['no'],
    ['off'],
    ['enabled'],
    // A near-miss is the realistic config mistake, and it must land on OFF.
    ['ture'],
    ['true '.repeat(2)],
    ['y'],
  ])('treats %o as OFF', (value) => {
    process.env[X_API_ENABLED_ENV] = value;
    expect(xApiEnabled()).toBe(false);
  });

  it('is read at call time, so flipping the env takes effect immediately', () => {
    delete process.env[X_API_ENABLED_ENV];
    expect(xApiEnabled()).toBe(false);
    process.env[X_API_ENABLED_ENV] = 'true';
    expect(xApiEnabled()).toBe(true);
    process.env[X_API_ENABLED_ENV] = 'false';
    expect(xApiEnabled()).toBe(false);
  });
});

describe('xApiDisabledReason', () => {
  it('names the switch so an investigation lands on config, not the collector', () => {
    const reason = xApiDisabledReason('engage X analytics for post p1');
    expect(reason).toContain('engage X analytics for post p1');
    expect(reason).toContain(X_API_ENABLED_ENV);
  });
});
