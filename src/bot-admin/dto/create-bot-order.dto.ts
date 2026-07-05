import { IsString, IsNumber, IsArray, ValidateNested, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateBotOrderItemDto {
  @IsString()
  product_name: string;

  @IsOptional()
  @IsString()
  variant_text?: string | null;

  @IsNumber()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unit_price?: number;
}

export class CreateBotOrderDto {
  @IsNumber()
  bot_channel_user_id: number;

  @IsOptional()
  @IsString()
  customer_name?: string | null;

  @IsOptional()
  @IsString()
  customer_phone?: string | null;

  @IsOptional()
  @IsString()
  address?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateBotOrderItemDto)
  items: CreateBotOrderItemDto[];
}
