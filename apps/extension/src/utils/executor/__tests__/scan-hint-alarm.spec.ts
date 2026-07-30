// The 1-min fast-lane probe: it exists so a keyword created by (say) an
// operation plan gets scanned within ~a minute instead of waiting out the
// 15-min backstop alarm. The contract these tests pin down is that the probe is
// CHEAP — it must never drive the real scan loop unless the backend says there
// is work, because a false positive means a full unit walk every minute.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { backendCall, NotAuthenticatedError, runScanLoop, runPublishLoop, getValidAccessToken } =
  vi.hoisted(() => ({
    backendCall: vi.fn(),
    NotAuthenticatedError: class NotAuthenticatedError extends Error {},
    runScanLoop: vi.fn(async () => ({
      units: 0,
      posts: 0,
      accepted: 0,
      stoppedReason: 'idle',
    })),
    runPublishLoop: vi.fn(async () => ({})),
    getValidAccessToken: vi.fn(async () => 'tok'),
  }));

vi.mock('../api', () => ({ backendCall, NotAuthenticatedError }));
vi.mock('../publish.runner', () => ({ runPublishLoop }));
vi.mock('@gitroom/extension/utils/auth.service', () => ({ getValidAccessToken }));
// Keep the REAL hasPendingScanWork (it is what these tests exercise, through
// the mocked transport) while stubbing the expensive loop it can escalate to.
vi.mock('../scan.runner', async (importActual) => ({
  ...(await importActual<typeof import('../scan.runner')>()),
  runScanLoop,
}));

import { hasPendingScanWork } from '../scan.runner';

describe('hasPendingScanWork', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hits the cheap hint endpoint, not the scan-tasks ingest endpoint', async () => {
    backendCall.mockResolvedValue({ ok: true, status: 200, data: { work: true } });
    expect(await hasPendingScanWork()).toBe(true);
    expect(backendCall).toHaveBeenCalledWith('/engage/scan-tasks/hint', 'GET');
  });

  it('reports no work when the backend says so', async () => {
    backendCall.mockResolvedValue({ ok: true, status: 200, data: { work: false } });
    expect(await hasPendingScanWork()).toBe(false);
  });

  // Fails CLOSED on the extension side (the backend's own read fails open):
  // a flapping backend must not turn the 1-min alarm into a 1-min stream of
  // full scan loops. The 15-min backstop alarm covers the missed hint.
  it('reports no work on a non-ok response', async () => {
    backendCall.mockResolvedValue({ ok: false, status: 500, data: null });
    expect(await hasPendingScanWork()).toBe(false);
  });

  it('reports no work when there is no session', async () => {
    backendCall.mockRejectedValue(new NotAuthenticatedError());
    expect(await hasPendingScanWork()).toBe(false);
  });

  it('reports no work when the payload omits the flag', async () => {
    backendCall.mockResolvedValue({ ok: true, status: 200, data: {} });
    expect(await hasPendingScanWork()).toBe(false);
  });
});

describe('handleEngageHintAlarm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).chrome = {
      alarms: {
        get: vi.fn(async () => undefined),
        create: vi.fn(),
        clear: vi.fn(async () => true),
      },
    };
  });

  it('ignores alarms that are not the hint alarm', async () => {
    const { handleEngageHintAlarm } = await import('../scheduler');
    expect(await handleEngageHintAlarm('aisee-engage-scan')).toBe(false);
    expect(backendCall).not.toHaveBeenCalled();
  });

  it('does not drive the scan loop when there is no work', async () => {
    backendCall.mockResolvedValue({ ok: true, status: 200, data: { work: false } });
    const { handleEngageHintAlarm } = await import('../scheduler');
    expect(await handleEngageHintAlarm('aisee-engage-hint')).toBe(true);
    expect(runScanLoop).not.toHaveBeenCalled();
  });

  it('drives the scan loop when the backend reports work', async () => {
    backendCall.mockResolvedValue({ ok: true, status: 200, data: { work: true } });
    const { handleEngageHintAlarm } = await import('../scheduler');
    expect(await handleEngageHintAlarm('aisee-engage-hint')).toBe(true);
    expect(runScanLoop).toHaveBeenCalledTimes(1);
  });

  // Claiming the alarm even on failure keeps the dispatch chain from falling
  // through to the unrelated handlers behind it.
  it('claims the alarm and swallows a scan failure', async () => {
    backendCall.mockResolvedValue({ ok: true, status: 200, data: { work: true } });
    runScanLoop.mockRejectedValueOnce(new Error('boom'));
    const { handleEngageHintAlarm } = await import('../scheduler');
    expect(await handleEngageHintAlarm('aisee-engage-hint')).toBe(true);
  });
});

describe('ensureEngageHintAlarm', () => {
  beforeEach(() => vi.clearAllMocks());

  it('arms a 1-min periodic alarm when a session exists', async () => {
    const create = vi.fn();
    (globalThis as any).chrome = {
      alarms: { get: vi.fn(async () => undefined), create, clear: vi.fn() },
    };
    const { ensureEngageHintAlarm } = await import('../scheduler');
    await ensureEngageHintAlarm();
    expect(create).toHaveBeenCalledWith('aisee-engage-hint', {
      delayInMinutes: 1,
      periodInMinutes: 1,
    });
  });

  // A signed-out browser must never poll the backend in the background.
  it('does not arm without a session', async () => {
    const create = vi.fn();
    (globalThis as any).chrome = {
      alarms: { get: vi.fn(async () => undefined), create, clear: vi.fn() },
    };
    getValidAccessToken.mockResolvedValueOnce(null as any);
    const { ensureEngageHintAlarm } = await import('../scheduler');
    await ensureEngageHintAlarm();
    expect(create).not.toHaveBeenCalled();
  });

  it('is idempotent when the alarm already exists', async () => {
    const create = vi.fn();
    (globalThis as any).chrome = {
      alarms: {
        get: vi.fn(async () => ({ name: 'aisee-engage-hint' })),
        create,
        clear: vi.fn(),
      },
    };
    const { ensureEngageHintAlarm } = await import('../scheduler');
    await ensureEngageHintAlarm();
    expect(create).not.toHaveBeenCalled();
  });
});
