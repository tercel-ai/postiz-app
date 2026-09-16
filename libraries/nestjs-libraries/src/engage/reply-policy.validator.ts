import { registerDecorator, ValidationOptions } from 'class-validator';

/** 'HH:MM', 24-hour. Same shape the admin-level publish window setting uses. */
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const LENGTHS = ['short', 'medium', 'long'];

/**
 * Validates the fields of a `{ [platform]: { … } }` reply-policy map that a
 * GATE later reads — the platform switch, the active-hours window, the daily
 * limit and the draft shape. Every other key is free-form and passes through
 * untouched.
 *
 * WHY A BOUNDARY CHECK AT ALL, when every reader already fails safe. Because
 * failing safe is the right behaviour for a JSON column that may hold anything,
 * and the wrong answer to give a caller: `dailyReplyLimit: "4"` would be stored,
 * answered with a 200, and then silently resolved as the default 4 — and the
 * only way to notice is to see that the number being enforced is not the number
 * that was set. One of these is worse still: `autoReplyEnabled: "false"` is a
 * non-empty string, so the driver's `if (!policy?.autoReplyEnabled)` reads it as
 * TRUE and the platform starts replying, which is the exact opposite of what
 * the caller asked for.
 *
 * Shared by both endpoints that write this blob (`SaveAutomationRepliesDto` and
 * `SaveEngageConfigDto`) rather than written twice: a second copy is how one of
 * them quietly stops matching the gates.
 *
 * Hand-written rather than `@ValidateNested({ each: true }) @Type(() => Dto)`,
 * which does NOT work on a plain object map: class-transformer builds no DTO
 * instance per VALUE, so the nested validators run against the wrong target and
 * reject even a well-formed body.
 */
export function IsReplyPolicyMap(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isReplyPolicyMap',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          if (value === undefined) return true;
          if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
          return Object.values(value as Record<string, unknown>).every(isReplyPolicy);
        },
        defaultMessage() {
          return (
            'each policy may set autoReplyEnabled as a boolean, windowStart/windowEnd as ' +
            '"HH:MM" (both, and not equal), timezone as a non-empty string, ' +
            'dailyReplyLimit as an integer >= 0, length as short|medium|long, and ' +
            'mentionTags as an array of strings'
          );
        },
      },
    });
  };
}

/** One platform's policy: every field a gate reads is the type it reads it as. */
function isReplyPolicy(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const policy = entry as Record<string, unknown>;

  if (policy.autoReplyEnabled !== undefined && typeof policy.autoReplyEnabled !== 'boolean') {
    return false;
  }

  const hasStart = policy.windowStart !== undefined;
  const hasEnd = policy.windowEnd !== undefined;
  // Both or neither: half a window is not a window, and the resolver would drop
  // it back to the default hours rather than honour it.
  if (hasStart !== hasEnd) return false;
  if (hasStart) {
    if (typeof policy.windowStart !== 'string' || !CLOCK_TIME.test(policy.windowStart)) {
      return false;
    }
    if (typeof policy.windowEnd !== 'string' || !CLOCK_TIME.test(policy.windowEnd)) {
      return false;
    }
    // start === end is a moment, not a window — and `withinLocalWindow` fails
    // closed on it, so it would silently stop this platform replying at all.
    if (policy.windowStart === policy.windowEnd) return false;
  }

  if (
    policy.timezone !== undefined &&
    (typeof policy.timezone !== 'string' || !policy.timezone)
  ) {
    return false;
  }

  if (policy.dailyReplyLimit !== undefined) {
    const limit = policy.dailyReplyLimit;
    // 0 is allowed: "configured, and off for now" is a real setting, distinct
    // from an absent field asking for the default.
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) return false;
  }

  if (
    policy.length !== undefined &&
    (typeof policy.length !== 'string' || !LENGTHS.includes(policy.length))
  ) {
    return false;
  }

  if (
    policy.mentionTags !== undefined &&
    (!Array.isArray(policy.mentionTags) ||
      policy.mentionTags.some((tag) => typeof tag !== 'string'))
  ) {
    return false;
  }

  return true;
}
