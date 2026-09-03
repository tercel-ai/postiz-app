import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  isExtensionPublishProvider,
  extensionPublishProviderIds,
} from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { EXTENSION_PUBLISHABLE_PLATFORMS } from '@gitroom/helpers/extension/post-publish';

describe('isExtensionPublishProvider', () => {
  it('is true for intrinsic extension-published providers (no usable server API)', () => {
    expect(isExtensionPublishProvider('hackernews')).toBe(true);
    expect(isExtensionPublishProvider('quora')).toBe(true);
    // Medium discontinued its write API → published via the extension.
    expect(isExtensionPublishProvider('medium')).toBe(true);
  });

  // The default send path is now the extension: the in-browser session path is
  // where this product is going and the backend API path is slated for removal,
  // so a post that does not choose goes to the extension.
  it('is true for API-capable providers too, now that the extension is the default', () => {
    expect(isExtensionPublishProvider('x')).toBe(true);
    expect(isExtensionPublishProvider('reddit')).toBe(true);
    expect(isExtensionPublishProvider('linkedin')).toBe(true);
    expect(isExtensionPublishProvider('devto')).toBe(true);
  });

  // The SYNC GUARD is what keeps the new default from being destructive: a
  // platform the extension cannot publish is never diverted, or its posts would
  // sit in QUEUE with no executor.
  it('still refuses platforms the extension cannot publish', () => {
    expect(isExtensionPublishProvider('mastodon')).toBe(false);
    expect(isExtensionPublishProvider('instagram')).toBe(false);
    expect(isExtensionPublishProvider('facebook')).toBe(false);
  });

  it('is case-insensitive and safe on empty/unknown input', () => {
    expect(isExtensionPublishProvider('HackerNews')).toBe(true);
    expect(isExtensionPublishProvider('')).toBe(false);
    expect(isExtensionPublishProvider('nope')).toBe(false);
  });
});

describe('extensionPublishProviderIds', () => {
  // This list is what the publish-due query matches legacy null-method posts
  // against, so it MUST agree with isExtensionPublishProvider — a platform
  // routed by one and not the other is a post neither path ever publishes.
  it('lists every extension-publishable platform by default', () => {
    const ids = extensionPublishProviderIds();
    for (const id of EXTENSION_PUBLISHABLE_PLATFORMS) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain('mastodon');
  });

  it('agrees with isExtensionPublishProvider on every platform it lists', () => {
    for (const id of extensionPublishProviderIds()) {
      expect(isExtensionPublishProvider(id)).toBe(true);
    }
  });
});

// The escape hatch for an extension fleet that is down: without it, unchosen
// posts on the publishable platforms wait in QUEUE for a browser that is not
// coming. Restores exactly the pre-default-flip routing.
describe('DEFAULT_PUBLISH_METHOD=api (operational escape hatch)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('narrows routing back to intrinsic-only', async () => {
    vi.stubEnv('DEFAULT_PUBLISH_METHOD', 'api');
    vi.resetModules();
    const mod = await import(
      '@gitroom/nestjs-libraries/integrations/integration.manager'
    );

    // Platforms with no server write API are still diverted — that is intrinsic,
    // not a default.
    expect(mod.isExtensionPublishProvider('hackernews')).toBe(true);
    expect(mod.isExtensionPublishProvider('quora')).toBe(true);
    // API-capable ones go back to the backend path.
    expect(mod.isExtensionPublishProvider('x')).toBe(false);
    expect(mod.isExtensionPublishProvider('reddit')).toBe(false);
    expect(mod.extensionPublishProviderIds()).not.toContain('x');
  });

  it('still honours the EXTENSION_PUBLISH_PLATFORMS allowlist underneath it', async () => {
    vi.stubEnv('DEFAULT_PUBLISH_METHOD', 'api');
    vi.stubEnv('EXTENSION_PUBLISH_PLATFORMS', 'x');
    vi.resetModules();
    const mod = await import(
      '@gitroom/nestjs-libraries/integrations/integration.manager'
    );

    expect(mod.isExtensionPublishProvider('x')).toBe(true);
    expect(mod.isExtensionPublishProvider('reddit')).toBe(false);
  });
});

describe('EXTENSION_PUBLISH_PLATFORMS env override (sync guard)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('routes a publishable dual-capable platform but ignores an unpublishable one', async () => {
    // The env is read at module load, so stub it then re-import a fresh copy.
    vi.stubEnv('EXTENSION_PUBLISH_PLATFORMS', 'x,mastodon');
    vi.resetModules();
    const mod = await import(
      '@gitroom/nestjs-libraries/integrations/integration.manager'
    );
    // x is extension-publishable → the env override routes it to the extension.
    expect(mod.isExtensionPublishProvider('x')).toBe(true);
    // devto is NOT extension-publishable → the guard ignores the misconfig, so it
    // keeps the backend path instead of stranding in QUEUE.
    expect(mod.isExtensionPublishProvider('mastodon')).toBe(false);
    expect(mod.extensionPublishProviderIds()).toContain('x');
    expect(mod.extensionPublishProviderIds()).not.toContain('mastodon');
  });
});
