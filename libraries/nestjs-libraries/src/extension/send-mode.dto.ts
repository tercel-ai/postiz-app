import {
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

class SendModeMutationDto {
  @IsInt()
  @Min(0)
  @Max(2147483646)
  expectedRevision!: number;

  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  requestId!: string;
}

export class SaveSendModeDto extends SendModeMutationDto {
  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  expectedOrganizationId!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  expectedUserId!: string;

  @IsIn(['AUTONOMOUS', 'CONTROLLED'])
  mode!: 'AUTONOMOUS' | 'CONTROLLED';
}

export class SaveSystemSendModeDto extends SendModeMutationDto {
  @IsBoolean()
  enabled!: boolean;
}

export class ResolveAutonomousEffectDto extends SendModeMutationDto {
  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  expectedOrganizationId!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  expectedUserId!: string;

  @IsIn(['CONFIRMED', 'NOT_SUBMITTED'])
  decision!: 'CONFIRMED' | 'NOT_SUBMITTED';

  @IsIn([true])
  executorStopped!: true;

  @IsIn([true])
  noPendingSubmit!: true;

  @IsString()
  @Matches(/\S/)
  @MaxLength(2000)
  evidence!: string;
}
