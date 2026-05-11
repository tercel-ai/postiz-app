import { IsDefined, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UserByUsernameDto {
  @IsString()
  @IsDefined()
  @IsNotEmpty()
  id: string;

  @IsString()
  @IsDefined()
  @IsNotEmpty()
  @MaxLength(100)
  username: string;
}
