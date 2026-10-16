import { NODE_ID_PATTERN } from './extension-node.protocol';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export class RegisterExtensionNodeDto {
  @Matches(NODE_ID_PATTERN) nodeId: string;
  @IsString() @MaxLength(128) requestId: string;
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsIn(['chrome', 'arc', 'firefox', 'edge', 'other']) browser: string;
  @IsIn(['ACCOUNT_BOUND_V1']) protocolVersion: string;
  @IsOptional() @IsString() @MaxLength(32) extensionVersion?: string;
  @IsObject() capabilities: Record<
    string,
    { post?: boolean; reply?: boolean; strictAccountVerification?: boolean }
  >;
}

export class SaveExtensionNodeDto {
  @Matches(NODE_ID_PATTERN) nodeId: string;
  @IsOptional() @IsString() @MaxLength(128) registeredByUserId?: string;
  @IsInt() @Min(1) expectedRevision: number;
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsIn(['REVOKED']) status?: 'REVOKED';
}
