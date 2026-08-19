import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SchedulePostsDto } from '../schedule-posts.dto';

const check = (body: any) =>
  validateSync(plainToInstance(SchedulePostsDto, body)).map((e) => e.property);

// The batch is named EITHER by explicit `posts` or by `planId`. ValidateIf is
// what makes each required only when the other is absent, and its semantics are
// easy to get wrong by inspection — a body naming NEITHER must still be
// rejected, which only holds because both conditions fire at once.
describe('SchedulePostsDto validation', () => {
  it('accepts posts alone', () => expect(check({ posts: [{ id: 'p1' }] })).toEqual([]));
  it('accepts planId alone', () => expect(check({ planId: 'plan-1' })).toEqual([]));
  it('rejects an empty body naming neither', () => {
    expect(check({}).sort()).toEqual(['planId', 'posts']);
  });
  it('rejects an empty posts array with no planId', () =>
    expect(check({ posts: [] })).toEqual(['posts']));
  it('rejects a bad publishMethod', () =>
    expect(check({ planId: 'p', publishMethod: 'carrier-pigeon' })).toEqual(['publishMethod']));

  it('accepts planId with a platforms filter', () =>
    expect(check({ planId: 'p', platforms: ['x', 'reddit'] })).toEqual([]));

  it('rejects platforms alone — it names no batch by itself', () => {
    // platforms has no bearing on posts'/planId's own ValidateIf conditions
    // (they check `!o.posts`/`!o.planId`, not `o.platforms`), so this must
    // fail exactly like the empty-body case — locked in explicitly since a
    // careless future edit to the ValidateIf predicates could silently let it
    // through.
    expect(check({ platforms: ['x'] }).sort()).toEqual(['planId', 'posts']);
  });

  it('rejects a non-string entry in platforms', () =>
    expect(check({ planId: 'p', platforms: [1] })).toEqual(['platforms']));

  // `platforms` + `posts` together is a controller-level 400, not a DTO
  // validation failure — @ValidateIf can only skip a field's OWN validators,
  // it cannot reject a field for another field's presence (see the class
  // comment). This DTO-level check confirms platforms alone still passes when
  // posts happens to be set, i.e. the rejection genuinely lives elsewhere and
  // isn't silently absent.
  it('platforms alongside posts passes DTO validation (the controller rejects the combination)', () =>
    expect(check({ posts: [{ id: 'p1' }], platforms: ['x'] })).toEqual([]));
});
