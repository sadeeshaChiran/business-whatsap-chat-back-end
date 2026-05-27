import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CreateCompanyDto } from './create-company.dto';

export class UpdateCompanyDto extends PartialType(CreateCompanyDto) {
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
}
