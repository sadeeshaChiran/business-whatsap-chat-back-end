import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateEvolutionInstanceSettingsDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  read_messages: boolean;
}
