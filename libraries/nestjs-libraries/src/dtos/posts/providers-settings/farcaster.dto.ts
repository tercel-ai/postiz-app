import { Type } from 'class-transformer';
import { IsOptional, IsString, Matches, ValidateNested } from 'class-validator';

export class FarcasterId {
  @IsString()
  id: string;
}
export class FarcasterValue {
  @ValidateNested()
  @Type(() => FarcasterId)
  value: FarcasterId;
}
export class FarcasterDto {
  @ValidateNested({ each: true })
  @Type(() => FarcasterValue)
  subreddit: FarcasterValue[];

  @IsOptional()
  @Matches(/^https:\/\/warpcast\.com\/[a-zA-Z0-9._-]+\/0x[a-fA-F0-9]+(\?.*)?$/, {
    message: 'Invalid Warpcast URL. Example: https://warpcast.com/username/0xabcdef',
  })
  quote_cast_url?: string;
}
