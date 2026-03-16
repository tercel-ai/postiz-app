import { IsIn, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

const PRICE_PATTERN = /^\d+(\.\d+)?$/;

export class AiPricingEntryDto {
  @IsString()
  servicer: string;

  @IsString()
  provider: string;

  @IsString()
  model: string;

  @IsIn(['per_token', 'per_image'])
  billing_mode: 'per_token' | 'per_image';

  @Matches(PRICE_PATTERN, { message: 'price must be a non-negative decimal string (e.g. "0.0015")' })
  price: string;

  @IsOptional()
  @Matches(PRICE_PATTERN, { message: 'input_price must be a non-negative decimal string (e.g. "0.000375")' })
  input_price?: string;

  @IsOptional()
  @Matches(PRICE_PATTERN, { message: 'output_price must be a non-negative decimal string (e.g. "0.0015")' })
  output_price?: string;
}

export class UpdateAiPricingDto {
  @ValidateNested()
  @Type(() => AiPricingEntryDto)
  text: AiPricingEntryDto;

  @ValidateNested()
  @Type(() => AiPricingEntryDto)
  image: AiPricingEntryDto;
}
