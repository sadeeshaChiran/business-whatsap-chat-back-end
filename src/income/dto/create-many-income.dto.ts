import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { CreateIncomeDto } from './create-income.dto';

export class CreateManyIncomeDto {
  @ApiProperty({ type: [CreateIncomeDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateIncomeDto)
  items!: CreateIncomeDto[];
}