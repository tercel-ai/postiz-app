import { describe, expect, it } from 'vitest';
import { decodeRedditIdFromJwt } from '../social-sessions';

const b64url = (obj: object) =>
  Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const jwtWithPayload = (payload: object) =>
  `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.signature`;

describe('decodeRedditIdFromJwt', () => {
  it('finds the t2_* account id regardless of which payload key holds it', () => {
    expect(
      decodeRedditIdFromJwt(jwtWithPayload({ sub: 't2_abc123', exp: 1 }))
    ).toBe('t2_abc123');
    expect(
      decodeRedditIdFromJwt(
        jwtWithPayload({ loid: 'anon', aid: 't2_ZZ9', exp: 1 })
      )
    ).toBe('t2_ZZ9');
  });

  it('returns undefined when no t2_* value exists in the payload', () => {
    expect(
      decodeRedditIdFromJwt(jwtWithPayload({ loid: 'anon-only', exp: 1 }))
    ).toBeUndefined();
  });

  it('returns undefined on malformed or empty tokens', () => {
    expect(decodeRedditIdFromJwt('')).toBeUndefined();
    expect(decodeRedditIdFromJwt('not-a-jwt')).toBeUndefined();
    expect(decodeRedditIdFromJwt('a.%%%.c')).toBeUndefined();
  });
});
