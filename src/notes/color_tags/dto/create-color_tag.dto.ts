import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateNoteColorTagsDto {
  @ApiProperty({ example: '#FFD966', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  color_code: string;

  @ApiProperty({ example: 'Reminder', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  meaning: string;

  @ApiProperty({ example: 'Name of Reminder', maxLength: 255, required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiProperty({ example: 1, minimum: 1, required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  company_id?: number;

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  is_common?: boolean;
}
