import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
  registerDecorator,
} from 'class-validator';
import { EXTENSION_PUBLISHABLE_PLATFORMS } from '@gitroom/helpers/extension/post-publish';
import { SendAction } from './send-binding.dto';

export type PlanRouteMap = Record<
  string,
  Partial<Record<SendAction, { integrationId: string | null }>>
>;
export function isPlanRouteMap(value: unknown): value is PlanRouteMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([platform, actions]) => {
    if (
      !(EXTENSION_PUBLISHABLE_PLATFORMS as readonly string[]).includes(
        platform
      ) ||
      !actions ||
      typeof actions !== 'object' ||
      Array.isArray(actions)
    )
      return false;
    const entries = Object.entries(actions);
    return (
      entries.length > 0 &&
      entries.every(([action, raw]) => {
        if (
          !['POST', 'REPLY'].includes(action) ||
          !raw ||
          typeof raw !== 'object' ||
          Array.isArray(raw)
        )
          return false;
        const item = raw as Record<string, unknown>;
        return (
          Object.keys(item).length === 1 &&
          (item.integrationId === null ||
            (typeof item.integrationId === 'string' &&
              item.integrationId.trim().length > 0 &&
              item.integrationId.length <= 128))
        );
      })
    );
  });
}
export function IsPlanRouteMap() {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isPlanRouteMap',
      target: object.constructor,
      propertyName,
      validator: {
        validate: isPlanRouteMap,
        defaultMessage: () =>
          'executionRoutes must map supported platforms and POST/REPLY actions to { integrationId: string | null }',
      },
    });
}
export class PlanDraftRouteDto {
  @IsString()
  @MaxLength(128)
  id!: string;

  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedRouteRevision!: number;
}
export class SavePlanExecutionDto {
  @IsPlanRouteMap()
  executionRoutes!: PlanRouteMap;

  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedRevision!: number;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PlanDraftRouteDto)
  drafts!: PlanDraftRouteDto[];

  @IsOptional()
  @IsString()
  @MaxLength(128)
  requestId?: string;
}
