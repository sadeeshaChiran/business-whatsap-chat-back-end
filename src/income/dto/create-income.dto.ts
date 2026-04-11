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
import { SourseType } from '../../expenses/entities/expense.entity';

export class CreateIncomeDto {
  @ApiProperty({ example: 15000, minimum: 1 })
  @IsInt()
  @Min(1)
  amount: number;

  @ApiProperty({ example: '2026-04-08T11:00:00.000Z' })
  @Type(() => Date)
  @IsDate()
  date: Date;

  @ApiPropertyOptional({
    example: 'Invoice payment',
    maxLength: 255,
    nullable: true,
  })
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
  income_category_id: number;
}
