import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { CreateCompanyDto } from './create-company.dto';

export class UpdateCompanyDto extends PartialType(
  OmitType(CreateCompanyDto, ['email', 'address'] as const),
) {
  @ApiPropertyOptional({
    description: 'Business contact email (not the user login email).',
    example: 'sales@acme.com',
    maxLength: 255,
  })
  @IsOptional()
  @ValidateIf((_obj, value) => value !== undefined && String(value).trim() !== '')
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({
    description: 'Business address.',
    example: 'Colombo, Sri Lanka',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  address?: string;

  @ApiPropertyOptional({ example: 1, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  industry_id?: number;

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
  @ApiPropertyOptional({
    description: 'Plain-text evaluation WhatsApp key stored in whatsapp_channels.',
    maxLength: 2048,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  whatsapp_evaluation_key?: string;

  @ApiPropertyOptional({
    description: 'WhatsApp instance name (updates whatsapp_channels.instance_name).',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  whatsapp_instance_name?: string;

  @ApiPropertyOptional({
    description: 'WhatsApp provider adapter: evolution or meta.',
    enum: ['evolution', 'meta'],
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  whatsapp_provider_type?: 'evolution' | 'meta';

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  meta_phone_number_id?: string;

  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  meta_access_token?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  meta_waba_id?: string;

  @ApiPropertyOptional({
    description: 'Meta webhook verify token configured in Meta Developer Console.',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  meta_verify_token?: string;

  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  evolution_api_base?: string;
}
