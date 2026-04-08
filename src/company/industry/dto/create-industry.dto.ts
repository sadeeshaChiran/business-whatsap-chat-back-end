import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateIndustryDto {
  @ApiProperty({ example: 'Retail', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
