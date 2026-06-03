import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateEvolutionInstanceDto {
  @ApiProperty({ example: 'my-shop-whatsapp' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  whatsapp_instance_name: string;

  /** Mark all incoming messages as read (Evolution “Read Messages”). Falls back to EVOLUTION_READ_MESSAGES. */
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  read_messages?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  always_online?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  groups_ignore?: boolean;
}
