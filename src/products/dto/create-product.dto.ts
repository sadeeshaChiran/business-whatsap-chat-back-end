import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CreateProductVariantDto } from './create-product-variant.dto';
import { VariantImageMatchDto } from './variant-image-match.dto';
import { VariantPriceMatchDto } from './variant-price-match.dto';

export class CreateProductDto {
  @ApiProperty({ example: 'Premium T-Shirt', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({ example: 'Soft cotton branded t-shirt' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: 'TS-045', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sku?: string;

  @ApiPropertyOptional({ example: 2000, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ example: 25, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  quantity?: number;

  @ApiPropertyOptional({ example: 'In Stock', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;

  @ApiProperty({ example: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  category_id: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  has_variants?: boolean;

  @ApiPropertyOptional({
    example: 'https://cdn.example.com/product.jpg',
    description: 'Cover image selected from the product gallery',
  })
  @IsOptional()
  @IsString()
  image_url?: string;

  @ApiPropertyOptional({
    example: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'],
    description: 'Common product gallery images',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  gallery?: string[];

  @ApiProperty({ example: 0.35, minimum: 0, description: 'Weight in kg' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  weight: number;

  @ApiPropertyOptional({ example: 'Soft sole, non-slip, loved by moms', description: 'Why customers love it (used by the sales bot)' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  selling_points?: string;

  @ApiPropertyOptional({ example: [12, 15], description: 'Add-on products the sales bot may suggest' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  related_product_ids?: number[];

  @ApiPropertyOptional({ example: true, description: 'false = the sales bot never mentions this product' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  show_to_bot?: boolean;

  @ApiPropertyOptional({ example: true, description: 'Available / Unavailable (default available)' })
  @IsOptional()
  @IsBoolean()
  is_available?: boolean;

  @ApiPropertyOptional({ type: [CreateProductVariantDto] })
  @IsOptional()
  @IsArray()
  @ArrayUnique(
    (variant: CreateProductVariantDto) =>
      `${variant.variant_name}:${variant.variant_value}`,
  )
  @ValidateNested({ each: true })
  @Type(() => CreateProductVariantDto)
  variants?: CreateProductVariantDto[];

  @ApiPropertyOptional({ type: VariantImageMatchDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => VariantImageMatchDto)
  variant_image_match?: VariantImageMatchDto | null;

  @ApiPropertyOptional({ type: VariantPriceMatchDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => VariantPriceMatchDto)
  variant_price_match?: VariantPriceMatchDto | null;
}
