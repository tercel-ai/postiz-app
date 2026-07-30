import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  isExtensionPublishProvider,
  extensionPublishProviderIds,
} from '@gitroom/nestjs-libraries/integrations/integration.manager';

describe('isExtensionPublishProvider', () => {
  it('is true for intrinsic extension-published providers (no usable server API)', () => {
    expect(isExtensionPublishProvider('hackernews')).toBe(true);
    expect(isExtensionPublishProvider('quora')).toBe(true);
    // Medium discontinued its write API → published via the extension.
    expect(isExtensionPublishProvider('medium')).toBe(true);
  });

  it('is false for API-capable providers by default', () => {
    expect(isExtensionPublishProvider('x')).toBe(false);
    expect(isExtensionPublishProvider('reddit')).toBe(false);
    // Mastodon keeps its working REST API → published by the backend provider.
    expect(isExtensionPublishProvider('mastodon')).toBe(false);
  });

  it('is case-insensitive and safe on empty/unknown input', () => {
    expect(isExtensionPublishProvider('HackerNews')).toBe(true);
    expect(isExtensionPublishProvider('')).toBe(false);
    expect(isExtensionPublishProvider('nope')).toBe(false);
  });
});

describe('extensionPublishProviderIds', () => {
  it('lists the intrinsic extension-published providers', () => {
    const ids = extensionPublishProviderIds();
    expect(ids).toContain('hackernews');
    expect(ids).toContain('quora');
    expect(ids).toContain('medium');
    // API-capable providers are not in the default set.
    expect(ids).not.toContain('x');
    expect(ids).not.toContain('reddit');
    expect(ids).not.toContain('mastodon');
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
