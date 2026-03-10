import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateSettingDto {
  @IsString()
  @IsNotEmpty()
  key: string;

  @IsNotEmpty()
  value: any;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateSettingDto {
  @IsNotEmpty()
  value: any;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  description?: string;
}
