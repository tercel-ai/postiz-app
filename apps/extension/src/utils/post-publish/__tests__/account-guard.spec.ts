// The wrong-account guard: publishing happens with the browser's own session,
// so a post must not go out when that session is a DIFFERENT account than the
// one it was composed for. Posting to the wrong account is not undoable, which
// is why this blocks rather than warns — but it must equally not block when it
// has no real evidence of a mismatch, or an unprobeable platform would take the
// whole feature offline.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@gitroom/extension/utils/social-sessions', () => ({
  probeSessionAccount: vi.fn(),
}));

import { probeSessionAccount } from '@gitroom/extension/utils/social-sessions';
import {
  checkPublishAccount,
  normalizeAccountId,
  normalizeHandle,
} from '../account-guard';
import type { PublishPostItem } from '@gitroom/helpers/extension/post-publish';

const probe = vi.mocked(probeSessionAccount);

function item(overrides: Partial<PublishPostItem> = {}): PublishPostItem {
  return {
    taskId: 'post-1',
    platform: 'reddit',
    segments: [{ text: 'hello' }],
    ...overrides,
  } as PublishPostItem;
}

beforeEach(() => {
  probe.mockReset();
});

describe('normalizeAccountId', () => {
  it('makes Reddit\'s bare id and the session fullname compare equal', () => {
    // The Integration stores `abc123`; the browser session reports `t2_abc123`.
    expect(normalizeAccountId('abc123')).toBe(normalizeAccountId('t2_abc123'));
  });

  it('ignores case and surrounding whitespace', () => {
    expect(normalizeAccountId('  T2_AbC123 ')).toBe('abc123');
  });

  it('leaves a numeric X id untouched', () => {
    expect(normalizeAccountId('1234567890')).toBe('1234567890');
  });
});

describe('normalizeHandle', () => {
  it('strips @ and u/ decorations', () => {
    expect(normalizeHandle('@Alice')).toBe('alice');
    expect(normalizeHandle('u/Alice')).toBe('alice');
    expect(normalizeHandle('/u/Alice')).toBe('alice');
  });
});

describe('checkPublishAccount', () => {
  it('blocks when the session is a different account', async () => {
    probe.mockResolvedValue({ supported: true, loggedIn: true, id: 't2_other' });

    const result = await checkPublishAccount(
      item({ targetAccount: { id: 'mine', handle: 'alice' } })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Wrong reddit account');
    // The message has to say nothing went out, or the user re-posts manually
    // and ends up double-publishing once the guard is satisfied.
    expect(result.error).toContain('nothing was posted');
  });

  it('allows when the session is the same account despite the t2_ prefix', async () => {
    probe.mockResolvedValue({
      supported: true,
      loggedIn: true,
      id: 't2_abc123',
    });

    const result = await checkPublishAccount(
      item({ targetAccount: { id: 'abc123' } })
    );

    expect(result.ok).toBe(true);
  });

  it('blocks when the platform is logged out', async () => {
    probe.mockResolvedValue({ supported: true, loggedIn: false });

    const result = await checkPublishAccount(
      item({ targetAccount: { id: 'abc123', handle: 'alice' } })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Not logged in');
    expect(result.error).toContain('@alice');
  });

  it('allows a post with no bound account — publishing as whoever is logged in IS the intent', async () => {
    const result = await checkPublishAccount(item());

    expect(result.ok).toBe(true);
    // No probe should even be attempted: there is nothing to compare against.
    expect(probe).not.toHaveBeenCalled();
  });

  it('allows when the platform has no session probe', async () => {
    // Otherwise every linkedin/medium/quora post would fail rather than publish.
    probe.mockResolvedValue({ supported: false, loggedIn: false });

    const result = await checkPublishAccount(
      item({ platform: 'medium', targetAccount: { id: 'whoever' } })
    );

    expect(result.ok).toBe(true);
  });

  it('allows when the probe throws — a lookup hiccup is not evidence of a mismatch', async () => {
    probe.mockRejectedValue(new Error('cookies API unavailable'));

    const result = await checkPublishAccount(
      item({ targetAccount: { id: 'abc123' } })
    );

    expect(result.ok).toBe(true);
  });

  it('falls back to comparing handles when the session reports no id', async () => {
    probe.mockResolvedValue({
      supported: true,
      loggedIn: true,
      handle: 'someone-else',
    });

    const result = await checkPublishAccount(
      item({ targetAccount: { id: 'abc123', handle: 'alice' } })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('@someone-else');
  });

  it('allows when neither an id nor a handle can be compared', async () => {
    probe.mockResolvedValue({ supported: true, loggedIn: true });

    const result = await checkPublishAccount(
      item({ targetAccount: { id: 'abc123' } })
    );

    expect(result.ok).toBe(true);
  });
});
