import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';

export class CreateColorTagDto {
	@ApiProperty({ example: '#FFD966', maxLength: 255 })
	@IsString()
	@MaxLength(255)
	color_code: string;

	@ApiProperty({ example: 'Reminder', maxLength: 255 })
	@IsString()
	@MaxLength(255)
	meaning: string;

	@ApiProperty({ example: 1, minimum: 1 })
	@IsInt()
	@Min(1)
	company_id: number;
}
