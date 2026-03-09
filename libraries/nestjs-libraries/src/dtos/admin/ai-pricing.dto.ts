import { IsIn, IsNumber, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class AiPricingEntryDto {
  @IsString()
  servicer: string;

  @IsString()
  provider: string;

  @IsString()
  model: string;

  @IsIn(['per_token', 'per_image'])
  billing_mode: 'per_token' | 'per_image';

  @IsNumber()
  @Min(0)
  price: number;
}

export class UpdateAiPricingDto {
  @ValidateNested()
  @Type(() => AiPricingEntryDto)
  text: AiPricingEntryDto;

  @ValidateNested()
  @Type(() => AiPricingEntryDto)
  image: AiPricingEntryDto;
}
