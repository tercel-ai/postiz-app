// The provider settings DTOs carry class-transformer/class-validator
// decorators, which need the reflect-metadata polyfill at import time.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  allProviders,
  EmptySettings,
} from '../all.providers.settings';
import { Post } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import { socialIntegrationList } from '@gitroom/nestjs-libraries/integrations/integration.manager';

// A post's `settings.__type` is validated against this whitelist, so a provider
// that is registered in the integration manager but missing here makes every
// save of that channel fail with a 400. Keep the two lists in lockstep.
describe('allProviders whitelist', () => {
  const allowed = allProviders(EmptySettings).map((p) => p.name);

  it('covers every registered social provider identifier', () => {
    const missing = socialIntegrationList
      .map((p) => p.identifier)
      .filter((id) => !allowed.includes(id));

    expect(missing).toEqual([]);
  });

  it('includes the extension-published article/forum platforms', () => {
    expect(allowed).toEqual(
      expect.arrayContaining(['quora', 'hackernews', 'medium', 'devto'])
    );
  });

  it('has no duplicate entries', () => {
    expect(allowed).toEqual([...new Set(allowed)]);
  });
});

const buildPost = (settings: Record<string, unknown>) => ({
  value: [{ content: 'hello world', id: 'a', image: [] }],
  settings,
});

const validatePost = async (settings: Record<string, unknown>) => {
  const instance = plainToInstance(Post, buildPost(settings));
  return validate(instance);
};

describe('Post.settings discriminator', () => {
  it('accepts a quora post, which carries no extra settings', async () => {
    expect(await validatePost({ __type: 'quora' })).toEqual([]);
  });

  it('accepts a hackernews post carrying a title', async () => {
    expect(
      await validatePost({ __type: 'hackernews', title: 'Show HN: Postiz' })
    ).toEqual([]);
  });

  it('rejects a hackernews post with no title', async () => {
    const errors = await validatePost({ __type: 'hackernews' });
    expect(JSON.stringify(errors)).toContain('title');
  });

  it('accepts a hackernews post with no url (plain text post)', async () => {
    expect(
      await validatePost({ __type: 'hackernews', title: 'Ask HN: anything' })
    ).toEqual([]);
  });

  it('accepts a hackernews post carrying a link url (Show HN style)', async () => {
    expect(
      await validatePost({
        __type: 'hackernews',
        title: 'Show HN: Postiz',
        url: 'https://example.com/product',
      })
    ).toEqual([]);
  });

  it('rejects a hackernews post with a malformed url', async () => {
    const errors = await validatePost({
      __type: 'hackernews',
      title: 'Show HN: Postiz',
      url: 'not-a-url',
    });
    expect(JSON.stringify(errors)).toContain('url');
  });

  it('still rejects an unknown provider', async () => {
    const errors = await validatePost({ __type: 'myspace' });
    expect(JSON.stringify(errors)).toContain('__type');
  });
});
