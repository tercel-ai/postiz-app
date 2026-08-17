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
});
