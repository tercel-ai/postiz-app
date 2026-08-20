import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';

/** 'HH:MM', 24-hour. Same shape the admin-level publish window setting uses. */
const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface PublishingWindowInput {
  start: string;
  end: string;
  // Absent = inherit the timezone of the admin-level window this one narrows,
  // falling back to UTC. Not defaulted: "the caller said nothing" and "the
  // caller said UTC" resolve differently.
  timezone?: string;
}

/**
 * Validates a `{ [platform]: { start, end, timezone? } }` map.
 *
 * Hand-written rather than `@ValidateNested({ each: true }) @Type(() => Dto)`,
 * which does NOT work on a plain object map: class-transformer does not build a
 * DTO instance per VALUE, so the nested validators run against the wrong target
 * and reject even a well-formed body. That failure is silent at compile time and
 * only shows up as a 400 on every save, so the map is checked explicitly here.
 */
function IsPublishingWindowMap(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isPublishingWindowMap',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown) {
          if (value === undefined) return true;
          if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
          return Object.values(value as Record<string, unknown>).every((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
            const w = entry as Record<string, unknown>;
            if (typeof w.start !== 'string' || !CLOCK_TIME.test(w.start)) return false;
            if (typeof w.end !== 'string' || !CLOCK_TIME.test(w.end)) return false;
            // start === end is a moment, not a window — and the service would
            // drop it as malformed anyway, so say so at the boundary instead.
            if (w.start === w.end) return false;
            if (w.timezone !== undefined && (typeof w.timezone !== 'string' || !w.timezone)) {
              return false;
            }
            return true;
          });
        },
        defaultMessage() {
          return 'windows must map each platform to { start: "HH:MM", end: "HH:MM", timezone?: string } with start !== end';
        },
      },
    });
  };
}

/**
 * Body for POST /projects/:projectId/automation/publishing.
 *
 * `platforms` is the COMPLETE enabled set, not a delta: every platform absent
 * from it is turned off. A partial-update shape would make "turn everything
 * off" inexpressible, which is exactly what the Automation master switch does.
 */
export class SaveAutomationPublishingDto {
  /**
   * The scheduled-publishing feature switch. Omit to leave it as it is — a
   * client changing only the platform list should not have to restate it.
   *
   * Independent from `platforms`: turning the feature off keeps the platform
   * selection intact so it comes back unchanged, which is why this is a column
   * of its own rather than "is the list empty".
   */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  platforms!: string[];

  // Per-platform publish-time windows, keyed by platform id. Only the platforms
  // named here are changed; a platform's stored window survives a save that
  // does not mention it.
  @IsOptional()
  @IsPublishingWindowMap()
  windows?: Record<string, PublishingWindowInput>;

  /**
   * Also commit the project's active plan to the send queue (DRAFT -> QUEUE),
   * scoped to `platforms`. Omitted/false saves the settings only.
   *
   * Folded into this one call because "choose platforms, then confirm" was two
   * round trips with an observable half-applied state between them: settings
   * saved, nothing queued.
   */
  @IsOptional()
  @IsBoolean()
  commit?: boolean;

  // Send path for the committed batch; omit to let the backend resolve each
  // post's only viable path. Only meaningful with `commit`.
  @IsOptional()
  @IsIn(['extension', 'api'])
  publishMethod?: 'extension' | 'api';
}

/**
 * Body for POST /projects/:projectId/automation/replies — the managed-reply
 * half of Automation: whether Engage runs for this project, how unattended it
 * is, and the per-platform reply policy.
 *
 * Per-ACCOUNT authorization is deliberately not here: Automation sends through
 * the extension's own browser session and never picks an account. Choosing a
 * specific account is a per-post edit, on a different surface.
 *
 * Every field is optional and only what is present is written, so a client can
 * flip one switch without restating the rest.
 */
export class SaveAutomationRepliesDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(['off', 'review', 'auto'])
  autoReplyMode?: 'off' | 'review' | 'auto';

  // Per-platform REPLY policy (strategy, length, mention tags, pacing…). Merged
  // key-by-key over what is stored, so it cannot clobber the publishing keys
  // that currently share the same column.
  @IsOptional()
  @IsObject()
  policies?: Record<string, Record<string, unknown>>;
}

/**
 * Body for POST /projects/:projectId/automation/enabled — the project's
 * Automation master switch.
 *
 * Its own endpoint rather than a field on the two feature endpoints: it governs
 * both of them, and folding it into either would make "turn everything off" a
 * write that also has to carry that feature's whole configuration.
 */
export class SaveAutomationEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}
