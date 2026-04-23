import { IsBooleanString, IsOptional } from 'class-validator';

export class BotFlagsQueryDto {
  @IsOptional()
  @IsBooleanString()
  unresolved?: string = 'true';
}
