import { IsDefined, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export class UserByUsernameDto {
  @IsString()
  @IsOptional()
  id?: string;

  @ValidateIf((o) => !o.id)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  provider?: string;

  @IsString()
  @IsDefined()
  @IsNotEmpty()
  @MaxLength(100)
  username: string;
}
