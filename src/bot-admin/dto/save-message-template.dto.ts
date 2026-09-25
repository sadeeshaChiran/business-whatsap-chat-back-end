import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, IsUrl, MaxLength, ValidateNested } from 'class-validator';

class MessageTemplateButtonDto {
  @IsString() @MaxLength(20) label: string;
  @IsOptional() @IsUrl({ require_protocol: true }) url?: string;
  @IsOptional() @IsString() @MaxLength(1000) payload?: string;
}

export class SaveMessageTemplateDto {
  @IsString() @MaxLength(120) name: string;
  @IsOptional() @IsString() @MaxLength(160) title?: string;
  @IsString() @MaxLength(2000) body: string;
  @IsOptional() @IsUrl({ require_protocol: true }) image_url?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => MessageTemplateButtonDto)
  buttons?: MessageTemplateButtonDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(2) @IsIn(['messenger', 'instagram'], { each: true })
  platforms?: string[];
}

export class SendMessageTemplateDto {
  @IsOptional() @IsString() @MaxLength(2000) body?: string;
  @IsOptional() @IsString() @MaxLength(160) title?: string;
  @IsOptional() @IsUrl({ require_protocol: true }) image_url?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => MessageTemplateButtonDto)
  buttons?: MessageTemplateButtonDto[];
}
