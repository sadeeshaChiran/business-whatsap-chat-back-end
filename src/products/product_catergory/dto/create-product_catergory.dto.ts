import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { CreateProductCategoryVariantDto } from './create-product-category-variant.dto';

export class CreateProductCatergoryDto {
  @ApiProperty({ example: 'Apparel', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  is_common?: boolean;

  @ApiPropertyOptional({ type: [CreateProductCategoryVariantDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateProductCategoryVariantDto)
  default_variants?: CreateProductCategoryVariantDto[];
}
