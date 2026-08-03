import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MediumSettingsDto } from '../medium.settings.dto';

function props(errs: any[]): string[] {
  return errs.map((e) => e.property);
}

// Medium's subtitle is optional on the platform itself and unused by both
// publish paths (API provider + extension poster) — the DTO must not 400 a
// post that omits it.
describe('MediumSettingsDto subtitle', () => {
  it('accepts a payload without a subtitle', async () => {
    const dto = plainToInstance(MediumSettingsDto, { title: 'My post' });
    expect(props(await validate(dto as object))).toEqual([]);
  });

  it('accepts an empty-string subtitle (untouched form field)', async () => {
    const dto = plainToInstance(MediumSettingsDto, {
      title: 'My post',
      subtitle: '',
    });
    expect(props(await validate(dto as object))).toEqual([]);
  });

  it('still enforces min length on a provided subtitle', async () => {
    const dto = plainToInstance(MediumSettingsDto, {
      title: 'My post',
      subtitle: 'a',
    });
    expect(props(await validate(dto as object))).toContain('subtitle');
  });

  it('still requires the title', async () => {
    const dto = plainToInstance(MediumSettingsDto, { subtitle: 'A subtitle' });
    expect(props(await validate(dto as object))).toContain('title');
  });
});
