import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  IntegrationManager,
  PublishMethodError,
  isExtensionOnlyProvider,
  resolvePublishMethod,
} from '../integration.manager';

// resolvePublishMethod is the SINGLE place both send paths agree on the route,
// so a post can never be picked up by both executors (the double-publish guard).
// These tests pin the capability model + the user-choice rules.
//   - x/reddit/linkedin: extension-publishable AND have a backend API (dual).
//   - hackernews/medium/quora: extension-only (no usable backend write API).
//   - 'devto' stands in for an API-only platform: not extension-publishable and
//     not extension-only, so it models "backend API only" regardless of whether
//     the provider registry lists it.

describe('isExtensionOnlyProvider', () => {
  it('is true only for platforms with no usable backend write API', () => {
    expect(isExtensionOnlyProvider('hackernews')).toBe(true);
    expect(isExtensionOnlyProvider('medium')).toBe(true);
    expect(isExtensionOnlyProvider('quora')).toBe(true);
  });

  it('is false for dual-capable and API-only platforms', () => {
    expect(isExtensionOnlyProvider('x')).toBe(false);
    expect(isExtensionOnlyProvider('reddit')).toBe(false);
    expect(isExtensionOnlyProvider('devto')).toBe(false);
    expect(isExtensionOnlyProvider('unknown-platform')).toBe(false);
  });
});

describe('resolvePublishMethod — auto (no user choice)', () => {
  it('extension-only platform -> extension even without a bound account', () => {
    expect(
      resolvePublishMethod({ platform: 'hackernews', hasBoundIntegration: false })
    ).toBe('extension');
  });

  it('dual-capable platform with a bound account -> defaults to extension', () => {
    expect(
      resolvePublishMethod({ platform: 'x', hasBoundIntegration: true })
    ).toBe('extension');
  });

  it('dual-capable platform without a bound account -> extension', () => {
    // still extension-publishable; the API path is just unavailable.
    expect(
      resolvePublishMethod({ platform: 'reddit', hasBoundIntegration: false })
    ).toBe('extension');
  });

  it('API-only platform with a bound account -> api', () => {
    expect(
      resolvePublishMethod({ platform: 'devto', hasBoundIntegration: true })
    ).toBe('api');
  });

  it('API-only platform without a bound account -> ACCOUNT_BINDING_REQUIRED', () => {
    expect(() =>
      resolvePublishMethod({ platform: 'devto', hasBoundIntegration: false })
    ).toThrowError(PublishMethodError);
    try {
      resolvePublishMethod({ platform: 'devto', hasBoundIntegration: false });
    } catch (e) {
      expect((e as PublishMethodError).code).toBe('ACCOUNT_BINDING_REQUIRED');
    }
  });
});

describe('resolvePublishMethod — explicit choice = api', () => {
  it('honours api when a dual-capable platform has a bound account', () => {
    expect(
      resolvePublishMethod({ platform: 'x', hasBoundIntegration: true, choice: 'api' })
    ).toBe('api');
  });

  it('rejects api on a dual-capable platform with no bound account', () => {
    try {
      resolvePublishMethod({ platform: 'x', hasBoundIntegration: false, choice: 'api' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PublishMethodError);
      expect((e as PublishMethodError).code).toBe('ACCOUNT_BINDING_REQUIRED');
    }
  });

  it('rejects api on an extension-only platform even when an account is bound', () => {
    // No usable backend write API -> API can never be honoured.
    try {
      resolvePublishMethod({ platform: 'medium', hasBoundIntegration: true, choice: 'api' });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as PublishMethodError).code).toBe('ACCOUNT_BINDING_REQUIRED');
    }
  });
});

describe('getSocialProviderList — static send-path flags', () => {
  const list = new IntegrationManager().getSocialProviderList();
  const byId = (id: string) => list.find((p) => p.identifier === id);

  it('carries extensionPublishable + hasWriteApi per provider', () => {
    // extension-only (no backend write API)
    expect(byId('hackernews')).toMatchObject({ extensionPublishable: true, hasWriteApi: false });
    expect(byId('medium')).toMatchObject({ extensionPublishable: true, hasWriteApi: false });
    // dual-capable (extension-publishable AND has a backend write API)
    expect(byId('x')).toMatchObject({ extensionPublishable: true, hasWriteApi: true });
    expect(byId('reddit')).toMatchObject({ extensionPublishable: true, hasWriteApi: true });
  });

  it('keeps identifier + name (backward compatible)', () => {
    const x = byId('x');
    expect(x?.identifier).toBe('x');
    expect(typeof x?.name).toBe('string');
  });
});

describe('resolvePublishMethod — explicit choice = extension', () => {
  it('honours extension on an extension-publishable platform', () => {
    expect(
      resolvePublishMethod({ platform: 'x', hasBoundIntegration: true, choice: 'extension' })
    ).toBe('extension');
  });

  it('rejects extension on an API-only platform', () => {
    try {
      resolvePublishMethod({ platform: 'devto', hasBoundIntegration: true, choice: 'extension' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PublishMethodError);
      expect((e as PublishMethodError).code).toBe('PLATFORM_NOT_EXTENSION_PUBLISHABLE');
    }
  });
});
