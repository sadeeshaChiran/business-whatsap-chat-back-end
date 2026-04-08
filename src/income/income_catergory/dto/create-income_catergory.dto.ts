import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateIncomeCatergoryDto {
  @ApiProperty({ example: 'Sales', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 1, minimum: 1 })
  @IsInt()
  @Min(1)
  company_id: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  is_common?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
