import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SaveEngageConfigDto } from '../dtos/engage.dto';
import { SaveAutomationRepliesDto } from '../../automation/automation.dto';

const check = (cls: any, body: unknown) =>
  validateSync(plainToInstance(cls, body)).map((e) => e.property);

// The reply-policy blob has TWO doors — the Engage config endpoint and the
// Automation replies endpoint — and one set of gates reading what they write.
// Both therefore run the same constraint, and these specs pin that: a body
// rejected at one door must be rejected at the other, or the stricter door is
// just a detour.
const doors: Array<[string, any, (policies: unknown) => unknown]> = [
  ['SaveEngageConfigDto', SaveEngageConfigDto, (replyPolicies) => ({ replyPolicies })],
  ['SaveAutomationRepliesDto', SaveAutomationRepliesDto, (policies) => ({ policies })],
];

describe.each(doors)('%s.replyPolicies validation', (_name, cls, body) => {
  const field = cls === SaveEngageConfigDto ? 'replyPolicies' : 'policies';

  it('accepts a fully specified policy', () => {
    expect(
      check(
        cls,
        body({
          reddit: {
            autoReplyEnabled: true,
            windowStart: '09:00',
            windowEnd: '18:00',
            timezone: 'Asia/Shanghai',
            dailyReplyLimit: 3,
            defaultStrategy: 'EXPERT_ANSWER',
            length: 'medium',
            mentionTags: ['@aisee'],
          },
        })
      )
    ).toEqual([]);
  });

  it('accepts an empty policy — every field is optional', () => {
    expect(check(cls, body({ reddit: {} }))).toEqual([]);
  });

  // A non-empty string is TRUTHY, so the driver's `if (!policy.autoReplyEnabled)`
  // reads "false" as ON and the platform starts replying — the exact opposite of
  // what the caller asked for. This is the one field where a wrong type does not
  // fail safe.
  it('rejects a stringly-typed switch', () => {
    expect(check(cls, body({ reddit: { autoReplyEnabled: 'false' } }))).toEqual([field]);
    expect(check(cls, body({ reddit: { autoReplyEnabled: 1 } }))).toEqual([field]);
  });

  it('rejects a malformed active-hours window', () => {
    expect(check(cls, body({ x: { windowStart: '9am', windowEnd: '18:00' } }))).toEqual([
      field,
    ]);
    // Half a window is not a window — the resolver would drop it back to the
    // default hours rather than honour it.
    expect(check(cls, body({ x: { windowStart: '08:00' } }))).toEqual([field]);
    expect(check(cls, body({ x: { windowEnd: '18:00' } }))).toEqual([field]);
    // start === end is a moment, and `withinLocalWindow` fails closed on it.
    expect(check(cls, body({ x: { windowStart: '08:00', windowEnd: '08:00' } }))).toEqual([
      field,
    ]);
  });

  it('rejects an unusable timezone', () => {
    expect(check(cls, body({ x: { timezone: '' } }))).toEqual([field]);
    expect(check(cls, body({ x: { timezone: 8 } }))).toEqual([field]);
  });

  // Stored and answered with a 200, "4" would resolve as the DEFAULT 4 — and the
  // only way to notice is to see that the number being enforced is not the one
  // that was set.
  it('rejects a daily limit that is not a whole non-negative number', () => {
    expect(check(cls, body({ x: { dailyReplyLimit: '4' } }))).toEqual([field]);
    expect(check(cls, body({ x: { dailyReplyLimit: 2.5 } }))).toEqual([field]);
    expect(check(cls, body({ x: { dailyReplyLimit: -1 } }))).toEqual([field]);
  });

  it('accepts a daily limit of 0 — "configured, and off for now"', () => {
    expect(check(cls, body({ x: { dailyReplyLimit: 0 } }))).toEqual([]);
  });

  // Clamping is the RESOLVER's job (it is what the driver enforces), so a body
  // asking for more than a platform tolerates is saved, not refused.
  it('accepts a limit above the platform ceiling', () => {
    expect(check(cls, body({ reddit: { dailyReplyLimit: 99 } }))).toEqual([]);
  });

  it('rejects a draft length outside the three tiers', () => {
    expect(check(cls, body({ x: { length: 'tiny' } }))).toEqual([field]);
    expect(check(cls, body({ x: { length: 'short' } }))).toEqual([]);
  });

  it('rejects mention tags that are not a list of strings', () => {
    expect(check(cls, body({ x: { mentionTags: '@aisee' } }))).toEqual([field]);
    expect(check(cls, body({ x: { mentionTags: ['@aisee', 7] } }))).toEqual([field]);
    expect(check(cls, body({ x: { mentionTags: [] } }))).toEqual([]);
  });

  it('rejects a policy that is not an object', () => {
    expect(check(cls, body({ x: 'on' }))).toEqual([field]);
    expect(check(cls, body({ x: ['on'] }))).toEqual([field]);
    expect(check(cls, body({ x: null }))).toEqual([field]);
  });

  // Free-form keys the gates do not read pass through: the blob is shared with
  // the publishing half and carries fields this constraint has no opinion on.
  it('leaves unknown keys alone', () => {
    expect(
      check(
        cls,
        body({
          x: {
            defaultStrategy: 'anything',
            brandStrength: 0.4,
            // The retired cadence, still written by older clients.
            checkIntervalMinutes: 300,
            publishingEnabled: true,
          },
        })
      )
    ).toEqual([]);
  });

  it('accepts an empty map and an omitted field', () => {
    // `{}` clears every platform, and omitting the field leaves them alone — two
    // real instructions, neither of them a validation error.
    expect(check(cls, body({}))).toEqual([]);
    expect(check(cls, {})).toEqual([]);
  });
});
