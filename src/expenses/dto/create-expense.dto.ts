import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { SourseType } from '../entities/expense.entity';

export class CreateExpenseDto {
  @ApiProperty({ example: 2500, minimum: 1 })
  @IsInt()
  @Min(1)
  amount: number;

  @ApiProperty({ example: '2026-04-08T10:00:00.000Z' })
  @Type(() => Date)
  @IsDate()
  date: Date;

  @ApiPropertyOptional({ example: 'Fuel', maxLength: 255, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note: string | null;

  @ApiPropertyOptional({ enum: SourseType, example: SourseType.manual })
  @IsOptional()
  @IsEnum(SourseType)
  sourse: SourseType;

  @ApiProperty({ example: 1, minimum: 1 })
  @IsInt()
  @Min(1)
  expense_category_id: number;
}
