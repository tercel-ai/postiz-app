import {
  IsString,
  Matches,
  MaxLength,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { EXTENSION_PUBLISHABLE_PLATFORMS } from '@gitroom/helpers/extension/post-publish';

export type SendAction = 'POST' | 'REPLY';
export interface AccountBindingInput {
  integrationId: string | null;
  expectedRevision: number;
}
export type AccountBindingMap = Record<string, AccountBindingInput>;

export function isAccountBindingMap(
  value: unknown
): value is AccountBindingMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > EXTENSION_PUBLISHABLE_PLATFORMS.length) return false;
  return entries.every(([platform, raw]) => {
    if (
      !(EXTENSION_PUBLISHABLE_PLATFORMS as readonly string[]).includes(platform)
    )
      return false;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const item = raw as Record<string, unknown>;
    return (
      Object.keys(item).every((k) =>
        ['integrationId', 'expectedRevision'].includes(k)
      ) &&
      (item.integrationId === null ||
        (typeof item.integrationId === 'string' &&
          item.integrationId.trim().length > 0 &&
          item.integrationId.length <= 128)) &&
      Number.isSafeInteger(item.expectedRevision) &&
      (item.expectedRevision as number) >= 0 &&
      (item.expectedRevision as number) < 2147483647
    );
  });
}

export type SendingAccountMap = Record<
  string,
  Partial<Record<SendAction, AccountBindingInput>>
>;

export function isSendingAccountMap(
  value: unknown
): value is SendingAccountMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(([platform, actions]) => {
      if (!actions || typeof actions !== 'object' || Array.isArray(actions))
        return false;
      const items = Object.entries(actions);
      return (
        items.length > 0 &&
        items.every(
          ([action, choice]) =>
            ['POST', 'REPLY'].includes(action) &&
            isAccountBindingMap({ [platform]: choice })
        )
      );
    })
  );
}

export class SaveSendingAccountsDto {
  @((object: object, propertyName: string) =>
    registerDecorator({
      name: 'isSendingAccountMap',
      target: object.constructor,
      propertyName,
      validator: {
        validate: isSendingAccountMap,
        defaultMessage: () =>
          'accounts must map supported platforms and POST/REPLY actions to versioned account selections',
      },
    }))
  accounts!: SendingAccountMap;

  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  requestId!: string;
}

export function IsAccountBindingMap(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isAccountBindingMap',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: isAccountBindingMap,
        defaultMessage: () =>
          'accounts must map supported platforms to { integrationId: string | null, expectedRevision: nonnegative integer }',
      },
    });
}
