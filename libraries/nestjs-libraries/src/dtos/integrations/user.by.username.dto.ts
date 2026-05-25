import { IsDefined, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UserByUsernameDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  provider?: string;

  @IsString()
  @IsDefined()
  @IsNotEmpty()
  @MaxLength(100)
  username: string;
}
