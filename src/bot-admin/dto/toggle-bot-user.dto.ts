import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class ToggleBotUserDto {
  @IsOptional()
  @IsBoolean()
  manual_mode?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  external_user_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  platform?: string;
}
