import { describe, expect, it } from 'vitest';
import {
  isRepliesActive,
  mergeEngageConfigMetadata,
  readEngageConfigMetadata,
} from '../engage-config-metadata';

// Every per-project setting now resolves through this one module, so its
// defaults ARE the product behaviour.
//
// The master switch defaults to OFF: Automation posts and replies with the
// user's real accounts, so a missing — or malformed — value must never read as
// authorized.
//
// The publishing switch is the one genuine three-state: absent means "never
// chosen", which the caller resolves from the platform selection, and that is
// distinct from an explicit false.
describe('readEngageConfigMetadata — defaults', () => {
  it('treats a row with nothing set as fully off', () => {
    const off = {
      automationEnabled: false,
      publishingEnabled: null,
      autoReplyMode: 'off',
      replyPolicies: {},
    };
    expect(readEngageConfigMetadata(null)).toEqual(off);
    expect(readEngageConfigMetadata({})).toEqual(off);
  });

  it('never reads an absent master switch as ON', () => {
    // Absence must not authorize posting and replying with real accounts.
    expect(readEngageConfigMetadata({ metadata: {} }).automationEnabled).toBe(false);
    expect(readEngageConfigMetadata({ metadata: { automationEnabled: true } }).automationEnabled).toBe(true);
    expect(readEngageConfigMetadata({ metadata: { automationEnabled: false } }).automationEnabled).toBe(false);
  });

  it('does not let other settings imply the master switch', () => {
    // Configuring replies is not the same as authorizing them to run unattended.
    expect(
      readEngageConfigMetadata({
        metadata: { autoReplyMode: 'auto', replyPolicies: { x: { autoReplyEnabled: true } } },
      }).automationEnabled
    ).toBe(false);
  });

  it('distinguishes an unset publishing switch from an explicit false', () => {
    expect(readEngageConfigMetadata({ metadata: {} }).publishingEnabled).toBeNull();
    expect(readEngageConfigMetadata({ metadata: { publishingEnabled: false } }).publishingEnabled).toBe(false);
  });

  it('ignores values of the wrong type instead of trusting them', () => {
    const meta = readEngageConfigMetadata({
      metadata: { automationEnabled: 'yes', publishingEnabled: 1, autoReplyMode: 'sometimes' },
    });
    // A malformed value falls to the SAFE side, not the permissive one.
    expect(meta.automationEnabled).toBe(false);
    expect(meta.publishingEnabled).toBeNull();
    expect(meta.autoReplyMode).toBe('off');
  });

  it('survives a malformed metadata blob', () => {
    for (const bad of ['nope', 42, [], null, undefined]) {
      expect(readEngageConfigMetadata({ metadata: bad }).autoReplyMode).toBe('off');
    }
  });
});

// The stored blob is JSON, so a value of the wrong shape is always possible.
// These pin that every malformed value falls to the safe side rather than being
// trusted or throwing.
describe('readEngageConfigMetadata — malformed input', () => {
  it('ignores an unknown reply mode', () => {
    expect(readEngageConfigMetadata({ metadata: { autoReplyMode: 'sometimes' } }).autoReplyMode).toBe('off');
  });

  it('drops non-object platform entries rather than spreading them later', () => {
    // {...'ab'} is {0:'a',1:'b'} — a merge downstream would quietly corrupt the
    // row, so a malformed entry is dropped at the boundary.
    expect(
      readEngageConfigMetadata({ metadata: { replyPolicies: { x: 'nope', reddit: { length: 'short' } } } })
        .replyPolicies
    ).toEqual({ reddit: { length: 'short' } });
  });

  it('lower-cases platform keys', () => {
    expect(
      readEngageConfigMetadata({ metadata: { replyPolicies: { LinkedIn: { autoReplyEnabled: true } } } })
        .replyPolicies
    ).toEqual({ linkedin: { autoReplyEnabled: true } });
  });
});

describe('mergeEngageConfigMetadata', () => {
  it('returns the FULL resolved set, not just the patch', () => {
    // The stored blob stays self-describing, so a reader never has to reassemble
    // it from a sparse diff.
    const merged = mergeEngageConfigMetadata(
      { metadata: { autoReplyMode: 'review', replyPolicies: { x: { length: 'short' } } } },
      { automationEnabled: true }
    );
    expect(merged).toEqual({
      automationEnabled: true,
      publishingEnabled: null,
      autoReplyMode: 'review',
      replyPolicies: { x: { length: 'short' } },
    });
  });

  it('leaves untouched keys exactly as they were', () => {
    const current = {
      metadata: {
        automationEnabled: false,
        publishingEnabled: true,
        autoReplyMode: 'auto',
        replyPolicies: { x: { length: 'long' } },
      },
    };
    expect(mergeEngageConfigMetadata(current, {})).toEqual({
      automationEnabled: false,
      publishingEnabled: true,
      autoReplyMode: 'auto',
      replyPolicies: { x: { length: 'long' } },
    });
  });

  it('can set publishingEnabled to false without it reading as "unset"', () => {
    // `?? current` would have let an explicit false fall through to the stored
    // value; the merge tests for `undefined` instead.
    expect(
      mergeEngageConfigMetadata({ metadata: { publishingEnabled: true } }, { publishingEnabled: false })
        .publishingEnabled
    ).toBe(false);
  });

  it('replaces replyPolicies rather than deep-merging them', () => {
    // Callers own the merge (only they know which keys are theirs), and a deep
    // merge here would make removing a platform impossible.
    expect(
      mergeEngageConfigMetadata(
        { metadata: { replyPolicies: { x: { length: 'short' }, reddit: { length: 'long' } } } },
        { replyPolicies: { x: { length: 'medium' } } }
      ).replyPolicies
    ).toEqual({ x: { length: 'medium' } });
  });
});

describe('isRepliesActive', () => {
  it('requires the master switch AND a non-off mode', () => {
    const cases: Array<[boolean, 'off' | 'review' | 'auto', boolean]> = [
      [true, 'review', true],
      [true, 'auto', true],
      [true, 'off', false],
      [false, 'review', false],
      [false, 'auto', false],
      [false, 'off', false],
    ];
    for (const [automationEnabled, autoReplyMode, expected] of cases) {
      expect(
        isRepliesActive({
          automationEnabled,
          autoReplyMode,
          publishingEnabled: null,
          replyPolicies: {},
        }),
        `${automationEnabled}/${autoReplyMode}`
      ).toBe(expected);
    }
  });
});
