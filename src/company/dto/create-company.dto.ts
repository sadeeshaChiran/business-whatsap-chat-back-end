import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateCompanyDto {
	@ApiProperty({ example: 'Acme Pvt Ltd', maxLength: 255 })
	@IsString()
	@MaxLength(255)
	name: string;

	@ApiProperty({ example: 'premium' })
	@IsString()
	plan: string;

	@ApiProperty({ example: 'hello@acme.com', maxLength: 255 })
	@IsEmail()
	@MaxLength(255)
	email: string;

	@ApiProperty({ example: '+94771234567', maxLength: 255 })
	@IsString()
	@MaxLength(255)
	phone: string;

	@ApiProperty({ example: 'Colombo, Sri Lanka', maxLength: 255 })
	@IsString()
	@MaxLength(255)
	address: string;

	@ApiProperty({ example: 1, minimum: 1 })
	@IsInt()
	@Min(1)
	industry_id: number;

	@ApiPropertyOptional({ example: true })
	@IsOptional()
	@IsBoolean()
	is_email_nofications?: boolean;

	@ApiPropertyOptional({ example: true })
	@IsOptional()
	@IsBoolean()
	is_weekly_report?: boolean;

	@ApiPropertyOptional({ example: true })
	@IsOptional()
	@IsBoolean()
	is_monthly_report?: boolean;
}
