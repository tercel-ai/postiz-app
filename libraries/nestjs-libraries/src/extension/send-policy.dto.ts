import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

class SendMutationDto {
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedRevision!: number;

  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  requestId!: string;
}

class SystemSendPolicyValueDto {
  @IsIn(['REQUIRED', 'OPTIONAL'])
  mode!: 'REQUIRED' | 'OPTIONAL';
}

export class SaveSystemSendPolicyDto extends SendMutationDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => SystemSendPolicyValueDto)
  value!: SystemSendPolicyValueDto;
}

export class SaveSendPreferencesDto extends SendMutationDto {
  @ValidateIf((_object, value) => value !== null)
  @IsBoolean()
  requirePreselectedAccount!: boolean | null;
}
