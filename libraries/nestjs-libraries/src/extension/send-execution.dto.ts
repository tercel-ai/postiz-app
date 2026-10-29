import {
  IsBoolean,
  IsIn,
  IsInt,
  Matches,
  Min,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
export class ClaimSendDto {
  @IsString() @MaxLength(128) requestId: string;
  @IsIn(['POST', 'REPLY']) action: 'POST' | 'REPLY';
  @IsOptional() @IsString() @Matches(/\S/) @MaxLength(128) rootPostId?: string;
}
export class SendOutcomeDto {
  @IsString() @MaxLength(200) eventId: string;
  @IsIn(['confirmed', 'unknown', 'definitely_not_submitted']) status:
    | 'confirmed'
    | 'unknown'
    | 'definitely_not_submitted';
  @IsOptional() @IsString() @MaxLength(256) platformId?: string;
  @IsOptional() @IsString() @MaxLength(2048) url?: string;
  @IsOptional() @IsBoolean() stopped?: boolean;
  @IsOptional() @IsString() @MaxLength(4096) evidence?: string;
  @IsOptional() @IsIn(['removed', 'gone']) removal?: 'removed' | 'gone';
}
export class EnqueueSendDto {
  @IsString() @Matches(/\S/) @MaxLength(128) rootPostId: string;
  @IsOptional() @IsIn(['API', 'EXTENSION']) publishMethod?: 'API' | 'EXTENSION';
}
export class StopSendDto {
  @IsString() @MaxLength(200) eventId: string;
  @IsString() @MaxLength(64) journalDigest: string;
  @IsString() @MaxLength(64) permitHash: string;
  @IsIn(['PREPARED', 'CANCELLED_BEFORE_SUBMIT']) lastPhase: string;
  @IsIn([true]) noPendingSubmit: true;
  @IsString() @MaxLength(40) executorStoppedAt: string;
}

export class ReconcileSendDto extends SendOutcomeDto {
  @IsInt() @Min(0) expectedResolutionRevision: number;
}

export class QueueStoredReplyDto {
  @IsUUID() sentReplyId: string;
  @IsOptional() @IsString() @MaxLength(128) integrationId?: string | null;
  // Optional legacy optimistic-concurrency metadata; simple callers only send the reply and account IDs.
  @IsOptional() @IsInt() @Min(0) expectedRouteRevision?: number;
  @IsOptional() @IsInt() @Min(1) expectedContentRevision?: number;
  @IsOptional() @IsString() @MaxLength(128) requestId?: string;
}

/** Full original reply scope plus an explicit review for a negative lookup. */
export class VerifySavedReplyDto extends ReconcileSendDto {
  @IsString() @MaxLength(100000) text: string;
  @IsString() @MaxLength(2048) targetUrl: string;
  @IsOptional() @IsBoolean() reviewedNotSent?: boolean;
}
