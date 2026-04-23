import { IsBoolean, IsOptional } from 'class-validator';

export class ToggleBotUserDto {
  @IsOptional()
  @IsBoolean()
  manual_mode?: boolean;
}
