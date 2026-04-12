import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { CreateExpenseDto } from './create-expense.dto';

export class CreateManyExpensesDto {
  @ApiProperty({ type: [CreateExpenseDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateExpenseDto)
  items: CreateExpenseDto[];
}