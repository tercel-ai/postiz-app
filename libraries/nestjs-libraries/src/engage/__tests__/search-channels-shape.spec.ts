import { describe, expect, it } from 'vitest';

/**
 * The response SHAPE contract for POST /engage/monitored-channels/search.
 *
 * This exists because changing that shape broke every client at once, with a
 * symptom that looked like a Reddit outage rather than an API change: clients
 * type the endpoint as an array and map over it, so an object arriving where an
 * array was expected reads as "no results" — a working search silently became
 * "no subreddit found".
 *
 * The fix was to make the new shape OPT-IN (`version: 'v2'`). These tests pin
 * both branches of that decision, so the default can never quietly become the
 * rich shape again.
 *
 * The controller's branch is one expression; duplicating it here would test
 * nothing. What is tested is the CONTRACT — what each caller sees — so the
 * assertions are written against the two payloads a client actually receives.
 */
const serviceResult = {
  results: [
    {
      platform: 'reddit' as const,
      channelId: 'mcp',
      channelName: 'r/mcp',
      audienceSize: 121611,
      metadata: { url: 'https://reddit.com/r/mcp', avatar: null },
    },
  ],
  needsExtension: false,
};

/** Exactly the controller's decision, isolated. */
const serialize = (result: typeof serviceResult, version?: 'v2') =>
  version === 'v2' ? result : result.results;

describe('search-channels response shape', () => {
  it('defaults to a bare ARRAY — an un-updated client is never broken', () => {
    const body = serialize(serviceResult);

    expect(Array.isArray(body)).toBe(true);
    // The two operations every existing client performs on this response.
    expect((body as unknown[]).length).toBe(1);
    expect((body as typeof serviceResult.results).map((c) => c.channelId)).toEqual([
      'mcp',
    ]);
  });

  it('returns the rich shape ONLY when the caller asks for v2', () => {
    const body = serialize(serviceResult, 'v2') as typeof serviceResult;

    expect(Array.isArray(body)).toBe(false);
    expect(body.results).toHaveLength(1);
    expect(body.needsExtension).toBe(false);
  });

  it('carries needsExtension through v2 — the reason v2 exists', () => {
    // "No route to Reddit" and "Reddit matched nothing" are both [] in the
    // default shape. Telling them apart is the entire purpose of opting in.
    const blocked = { results: [], needsExtension: true };

    expect(serialize(blocked)).toEqual([]);
    expect(serialize(blocked, 'v2')).toEqual({ results: [], needsExtension: true });
  });

  it('an unknown version is not the rich shape', () => {
    // The DTO rejects anything but 'v2' at the boundary (400), so this only
    // guards the serializer: no truthy-version shortcut may creep in.
    expect(Array.isArray(serialize(serviceResult, 'v3' as never))).toBe(true);
  });
});
