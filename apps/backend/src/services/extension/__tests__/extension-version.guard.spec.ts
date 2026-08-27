import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ExtensionVersionGuard,
  compareVersions,
  readMinExtensionVersion,
  MIN_EXTENSION_VERSION_KEY,
} from '../extension-version.guard';

// The gate that lets the API carry ONE contract instead of a shim per retired
// field. Two properties matter more than the comparison itself: it must not lock
// out anything that is not the extension, and a settings READ FAILURE must not
// enforce anything — it guards a contract, not a resource, so a hiccup there
// must never take the fleet down.
function buildGuard(floor: unknown, opts: { throws?: boolean } = {}) {
  const get = vi.fn(async () => {
    if (opts.throws) throw new Error('settings down');
    return floor;
  });
  const guard = new ExtensionVersionGuard({ get } as any);
  return { guard, get };
}

const setHeader = vi.fn();
const ctx = (headers: Record<string, string>) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
      getResponse: () => ({ setHeader }),
    }),
  } as any);

describe('ExtensionVersionGuard', () => {
  beforeEach(() => setHeader.mockClear());

  it('lets through anything that states no version', async () => {
    // The web app and server-to-server calls have no build to gate. Rejecting
    // them would take out the entire API, not just stale extensions.
    const { guard, get } = buildGuard('2.0.0');

    await expect(guard.canActivate(ctx({}))).resolves.toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('falls back to the built-in floor when nothing is stored', async () => {
    // The default is the build that introduced the version header. Anything
    // older cannot state a version at all and passes as "not the extension", so
    // this refuses exactly the builds that DO announce themselves and are behind.
    const { guard } = buildGuard(undefined);

    await expect(
      guard.canActivate(ctx({ 'x-aisee-ext-version': '1.9.0' }))
    ).rejects.toMatchObject({ status: 426, response: { minVersion: '1.10.0' } });
  });

  it('honours an empty stored value as "no floor"', async () => {
    // How an operator turns the gate off without deleting the key.
    const { guard } = buildGuard('');

    await expect(
      guard.canActivate(ctx({ 'x-aisee-ext-version': '0.0.1' }))
    ).resolves.toBe(true);
  });

  it('refuses a build below the floor with 426', async () => {
    const { guard } = buildGuard('2.0.0');

    await expect(
      guard.canActivate(ctx({ 'x-aisee-ext-version': '1.9.9' }))
    ).rejects.toMatchObject({
      // Not 400 (which a client may retry-loop on) and not 5xx (which reads as
      // "the server is broken"). 426 is the status HTTP defines for this.
      status: 426,
      response: { code: 'extension_upgrade_required', minVersion: '2.0.0' },
    });
  });

  it('serves a build exactly at the floor', async () => {
    const { guard } = buildGuard('2.0.0');

    await expect(
      guard.canActivate(ctx({ 'x-aisee-ext-version': '2.0.0' }))
    ).resolves.toBe(true);
  });

  it('reads the floor from settings, so raising it needs no deploy', async () => {
    // Raising the floor is an operational decision made when a contract changes.
    const { guard, get } = buildGuard('2.0.0');

    await guard
      .canActivate(ctx({ 'x-aisee-ext-version': '1.0.0' }))
      .catch(() => undefined);

    expect(get).toHaveBeenCalledWith(MIN_EXTENSION_VERSION_KEY);
  });

  it('tells a build that CLEARS the floor what the floor is', async () => {
    // The whole point of the header: a client learns the requirement while it
    // still works, so it can warn. 426 only arrives once it has already stopped.
    const { guard } = buildGuard('2.0.0');

    await guard.canActivate(ctx({ 'x-aisee-ext-version': '2.1.0' }));

    expect(setHeader).toHaveBeenCalledWith('x-aisee-ext-min-version', '2.0.0');
  });

  it('says nothing to callers that are not the extension', async () => {
    // The web app has no build to gate; a floor header would be noise it can
    // only misinterpret.
    const { guard } = buildGuard('2.0.0');

    await guard.canActivate(ctx({}));

    expect(setHeader).not.toHaveBeenCalled();
  });

  it('fails OPEN when settings cannot be read — NOT back to the default', async () => {
    // The distinction that matters now the default is non-empty: falling back to
    // it on a read failure would let a settings outage start REFUSING clients. A
    // gate that cannot read its own configuration must not enforce it. Nothing
    // behind it is protected BY it, so failing open costs one stale client one
    // more poll, while failing closed costs every user their automation.
    const { guard } = buildGuard(null, { throws: true });

    await expect(
      guard.canActivate(ctx({ 'x-aisee-ext-version': '0.0.1' }))
    ).resolves.toBe(true);
  });
});

describe('compareVersions', () => {
  it('compares segment by segment, not lexically', () => {
    // '10' < '9' as strings, which would serve a build the floor excludes.
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
  });

  it('treats missing segments as zero', () => {
    expect(compareVersions('1.3', '1.3.0')).toBe(0);
    expect(compareVersions('1.3.1', '1.3')).toBe(1);
  });

  it('sorts an unparseable segment LOW, so a malformed version is refused', () => {
    // A client sending something this format cannot express is not a client to
    // trust with the current contract.
    expect(compareVersions('1.x.0', '1.0.0')).toBe(0);
    expect(compareVersions('nonsense', '0.0.1')).toBe(-1);
  });
});

// Shared with `/public/extension/latest`, which publishes the same floor in its
// body. These cases exist at this level (and not only through the guard)
// because a second, disagreeing reading is the one failure the mechanism cannot
// survive: the endpoint would tell a client it is fine while every other call
// refuses it.
describe('readMinExtensionVersion', () => {
  const settings = (value: unknown, opts: { throws?: boolean } = {}) =>
    ({
      get: async () => {
        if (opts.throws) throw new Error('settings down');
        return value;
      },
    } as any);

  it('returns the stored floor, trimmed', async () => {
    expect(await readMinExtensionVersion(settings('  2.0.0 '))).toBe('2.0.0');
  });

  it('falls back to the built-in floor when nothing is stored', async () => {
    expect(await readMinExtensionVersion(settings(undefined))).toBe('1.10.0');
  });

  it('returns no floor at all when the settings read FAILS', async () => {
    // Not the default: a gate that cannot read its configuration must not
    // enforce it, and the endpoint must not publish a floor nobody enforces.
    expect(await readMinExtensionVersion(settings(null, { throws: true }))).toBe('');
  });
});
