import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  SaveAutomationEnabledDto,
  SaveAutomationPublishingDto,
  SaveAutomationRepliesDto,
} from '../automation.dto';

const check = (cls: any, body: unknown) =>
  validateSync(plainToInstance(cls, body)).map((e) => e.property);

// The `windows` map is validated by a hand-written constraint because the
// idiomatic `@ValidateNested({ each: true }) @Type(() => Dto)` pair does NOT
// work on a plain object map — class-transformer builds no DTO instance per
// value, so the nested validators run against the wrong target and reject a
// well-formed body. That regression is invisible at compile time and surfaces
// only as a 400 on every save, which is what these tests exist to catch.
describe('SaveAutomationPublishingDto', () => {
  it('accepts the body the Automation page actually sends', () => {
    expect(
      check(SaveAutomationPublishingDto, {
        platforms: ['x', 'reddit'],
        windows: { x: { start: '09:00', end: '18:00' } },
        commit: true,
      })
    ).toEqual([]);
  });

  it('accepts an empty platform list — that is the master switch off', () => {
    expect(check(SaveAutomationPublishingDto, { platforms: [] })).toEqual([]);
  });

  it('requires platforms', () => {
    expect(check(SaveAutomationPublishingDto, {})).toEqual(['platforms']);
  });

  it('accepts a window with an explicit timezone', () => {
    expect(
      check(SaveAutomationPublishingDto, {
        platforms: ['x'],
        windows: { x: { start: '09:00', end: '18:00', timezone: 'Asia/Shanghai' } },
      })
    ).toEqual([]);
  });

  it('rejects a 12-hour display label', () => {
    // The UI picks from "9:00 AM" labels; converting them is the client's job,
    // and a label reaching the wire means that conversion was skipped.
    expect(
      check(SaveAutomationPublishingDto, {
        platforms: ['x'],
        windows: { x: { start: '9:00 AM', end: '18:00' } },
      })
    ).toEqual(['windows']);
  });

  it('rejects out-of-range and malformed clock times', () => {
    for (const bad of ['24:00', '09:60', '9:00', '0900', '']) {
      expect(
        check(SaveAutomationPublishingDto, {
          platforms: ['x'],
          windows: { x: { start: bad, end: '18:00' } },
        })
      ).toEqual(['windows']);
    }
  });

  it('rejects equal bounds — a moment is not a window', () => {
    expect(
      check(SaveAutomationPublishingDto, {
        platforms: ['x'],
        windows: { x: { start: '18:00', end: '18:00' } },
      })
    ).toEqual(['windows']);
  });

  it('accepts a window that wraps past midnight', () => {
    expect(
      check(SaveAutomationPublishingDto, {
        platforms: ['x'],
        windows: { x: { start: '22:00', end: '02:00' } },
      })
    ).toEqual([]);
  });

  it('rejects a non-object windows value', () => {
    expect(
      check(SaveAutomationPublishingDto, { platforms: ['x'], windows: [{ start: '09:00', end: '18:00' }] })
    ).toEqual(['windows']);
    expect(check(SaveAutomationPublishingDto, { platforms: ['x'], windows: { x: 'nope' } })).toEqual([
      'windows',
    ]);
  });

  it('rejects a bad publishMethod', () => {
    expect(
      check(SaveAutomationPublishingDto, { platforms: ['x'], publishMethod: 'carrier-pigeon' })
    ).toEqual(['publishMethod']);
  });
});

describe('SaveAutomationRepliesDto', () => {
  it('accepts the body the Automation page actually sends', () => {
    expect(
      check(SaveAutomationRepliesDto, {
        enabled: true,
        autoReplyMode: 'review',
        policies: {
          x: {
            autoReplyEnabled: true,
            defaultStrategy: 'expert_answer',
            length: 'short',
            mentionTags: [],
            checkIntervalMinutes: 300,
          },
        },
      })
    ).toEqual([]);
  });

  it('accepts a flags-only body — a client may flip one switch', () => {
    expect(check(SaveAutomationRepliesDto, { enabled: false, autoReplyMode: 'off' })).toEqual([]);
  });

  it('rejects an unknown autoReplyMode', () => {
    expect(check(SaveAutomationRepliesDto, { autoReplyMode: 'sometimes' })).toEqual([
      'autoReplyMode',
    ]);
  });

  it('ignores a per-account payload — the field no longer exists', () => {
    // Automation never picks an account (everything sends through the
    // extension's own browser session), so a body carrying one is simply an
    // unrecognised property, not a validation error.
    expect(
      check(SaveAutomationRepliesDto, { enabled: true, accounts: [{ integrationId: 'i1' }] })
    ).toEqual([]);
  });
});

describe('SaveAutomationPublishingDto — feature switch', () => {
  it('accepts the switch alongside the platform list', () => {
    expect(
      check(SaveAutomationPublishingDto, { enabled: false, platforms: ['x'] })
    ).toEqual([]);
  });

  it('leaves the switch untouched when omitted', () => {
    // Optional on purpose: a client reordering platforms must not have to
    // restate the switch, or a stale value would flip the feature.
    expect(check(SaveAutomationPublishingDto, { platforms: ['x'] })).toEqual([]);
  });

  it('rejects a non-boolean switch', () => {
    expect(check(SaveAutomationPublishingDto, { enabled: 'yes', platforms: [] })).toEqual([
      'enabled',
    ]);
  });
});

describe('SaveAutomationEnabledDto', () => {
  it('accepts either boolean', () => {
    expect(check(SaveAutomationEnabledDto, { enabled: true })).toEqual([]);
    expect(check(SaveAutomationEnabledDto, { enabled: false })).toEqual([]);
  });

  it('requires the flag — an empty body must not read as "off"', () => {
    expect(check(SaveAutomationEnabledDto, {})).toEqual(['enabled']);
  });

  it('rejects a stringified boolean', () => {
    expect(check(SaveAutomationEnabledDto, { enabled: 'false' })).toEqual(['enabled']);
  });
});
