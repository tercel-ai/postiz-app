// MediumProvider pulls in MediumSettingsDto, whose class-transformer @Type
// decorator needs the reflect-metadata polyfill at import time.
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HackernewsProvider } from '../hackernews.provider';
import { QuoraProvider } from '../quora.provider';
import { MediumProvider } from '../medium.provider';
import { BadBody } from '@gitroom/nestjs-libraries/integrations/social.abstract';

const code = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64');

describe('HackernewsProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is an extension-published channel with the expected identity', () => {
    const p = new HackernewsProvider();
    expect(p.identifier).toBe('hackernews');
    expect(p.extensionPublish).toBe(true);
    expect(p.isBetweenSteps).toBe(false);
  });

  it('authenticates by validating the username against HN public API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => ({ id: 'pg', karma: 155000 }) }))
    );
    const res = await new HackernewsProvider().authenticate({
      code: code({ username: 'pg' }),
      codeVerifier: 'v',
    });
    expect(res).toMatchObject({ id: 'pg', username: 'pg', accessToken: 'pg', refreshToken: '' });
  });

  it('rejects an unknown HN username', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => null })));
    const res = await new HackernewsProvider().authenticate({
      code: code({ username: 'nope' }),
      codeVerifier: 'v',
    });
    expect(res).toBe('Hacker News user not found');
  });

  it('post() parks with a BadBody (no server publish)', async () => {
    await expect(
      new HackernewsProvider().post('i', 't', [{ id: 'p1', message: 'hi', settings: {} } as any], {} as any)
    ).rejects.toBeInstanceOf(BadBody);
  });
});

describe('QuoraProvider', () => {
  it('is an extension-published channel', () => {
    const p = new QuoraProvider();
    expect(p.identifier).toBe('quora');
    expect(p.extensionPublish).toBe(true);
  });

  it('authenticates from a profile slug (no API validation)', async () => {
    const res = await new QuoraProvider().authenticate({
      code: code({ username: 'profile/Jane-Doe' }),
      codeVerifier: 'v',
    });
    expect(res).toMatchObject({ id: 'Jane-Doe', username: 'Jane-Doe', name: 'Jane Doe' });
  });

  it('rejects an empty handle', async () => {
    const res = await new QuoraProvider().authenticate({ code: code({ username: '' }), codeVerifier: 'v' });
    expect(res).toBe('Invalid credentials');
  });

  it('post() parks with a BadBody', async () => {
    await expect(
      new QuoraProvider().post('i', 't', [{ id: 'p1', message: 'hi', settings: {} } as any], {} as any)
    ).rejects.toBeInstanceOf(BadBody);
  });
});

describe('MediumProvider (write API discontinued → extension-published)', () => {
  it('is an extension-published channel connecting by @handle', async () => {
    const p = new MediumProvider();
    expect(p.identifier).toBe('medium');
    expect(p.extensionPublish).toBe(true);
    const fields = await p.customFields();
    expect(fields[0].key).toBe('username');
  });

  it('authenticates from an @handle without hitting the dead API', async () => {
    const res = await new MediumProvider().authenticate({
      code: code({ username: '@ben' }),
      codeVerifier: 'v',
    });
    expect(res).toMatchObject({ id: 'ben', username: 'ben', accessToken: 'ben' });
  });

  it('post() parks with a BadBody (no server publish)', async () => {
    await expect(
      new MediumProvider().post('i', 't', [{ id: 'p1', message: 'hi', settings: { title: 'T' } } as any], {} as any)
    ).rejects.toBeInstanceOf(BadBody);
  });
});
