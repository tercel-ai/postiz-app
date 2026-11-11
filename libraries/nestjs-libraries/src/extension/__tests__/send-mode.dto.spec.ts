import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { BrowserWriteActorDto, BrowserWriteOutcomeDto } from '../send-mode.dto';

const owner = { expectedOrganizationId: 'org', expectedUserId: 'user', status: 'CONFIRMED' };
describe('BrowserWriteOutcomeDto actor observation', () => {
  it('validates an optional nested actor and preserves existing clients without actor data', () => {
    expect(validateSync(plainToInstance(BrowserWriteOutcomeDto, owner))).toEqual([]);
    const dto = plainToInstance(BrowserWriteOutcomeDto, { ...owner, actor: { id: '123', idNamespace: 'x.rest_id', handle: 'alice' } });
    expect(dto.actor).toBeInstanceOf(BrowserWriteActorDto);
    expect(validateSync(dto)).toEqual([]);
  });
  it.each([{ id: '', idNamespace: 'x.rest_id' }, { id: '123', idNamespace: '' }, { id: '123', idNamespace: 'x.rest_id', handle: 'a'.repeat(257) }])('rejects malformed nested actors (%j)', actor => {
    expect(validateSync(plainToInstance(BrowserWriteOutcomeDto, { ...owner, actor })).length).toBeGreaterThan(0);
  });
});

it('accepts the case-sensitive LinkedIn mini-profile namespace without changing its identity', () => {
 const actor={id:'ACoAAAMember',idNamespace:'linkedin.fs_miniProfile'};
 const dto=plainToInstance(BrowserWriteOutcomeDto,{...owner,actor});
 expect(validateSync(dto)).toEqual([]);
 expect(dto.actor?.idNamespace).toBe('linkedin.fs_miniProfile');
});
