import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
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

export class CancelSendModeTransitionDto extends SendModeMutationDto {
  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  expectedOrganizationId!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  expectedUserId!: string;
}

export class SaveSendModeDto extends CancelSendModeTransitionDto {
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

class BrowserWriteOwnerDto {
  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  expectedOrganizationId!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  expectedUserId!: string;
}

export class BeginBrowserWriteDto extends BrowserWriteOwnerDto {
  @IsOptional()
  @IsBoolean()
  handoverAccountVerification?: boolean;

  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  requestId!: string;

  @IsString()
  @Matches(/^[a-z][a-z0-9.-]{0,63}$/)
  platform!: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  contentHash!: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  postId?: string;

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  sentReplyId?: string;
}

export class BrowserWriteOutcomeDto extends BrowserWriteOwnerDto {
  @IsIn(['CONFIRMED', 'UNKNOWN', 'NOT_SUBMITTED'])
  status!: 'CONFIRMED' | 'UNKNOWN' | 'NOT_SUBMITTED';

  @IsOptional()
  @IsString()
  @Matches(/\S/)
  @MaxLength(2048)
  platformPostId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^https?:\/\//)
  @MaxLength(4096)
  url?: string;
}

export class BrowserReplyRecoveryDto extends BrowserWriteOwnerDto {
  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  requestId!: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  expectedRecoveryRevision!: string;

  @IsOptional()
  @IsIn([true])
  reviewConfirmed?: true;
}

export class ResolveLegacyReplyRecoveryDto extends BrowserReplyRecoveryDto {
  @IsIn([true])
  executorStopped!: true;

  @IsIn([true])
  noPendingSubmit!: true;

  @IsIn([true])
  replyAbsent!: true;

  @IsString()
  @Matches(/\S/)
  @MaxLength(2000)
  evidence!: string;
}

export class ResolveLegacyPostRecoveryDto extends BrowserReplyRecoveryDto {
  @IsIn([true])
  executorStopped!: true;

  @IsIn([true])
  noPendingSubmit!: true;

  @IsString()
  @Matches(/\S/)
  @MaxLength(2000)
  evidence!: string;
}
