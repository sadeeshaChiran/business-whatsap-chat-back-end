import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class CreateProductCategoryVariantDto {
  @ApiProperty({ example: 'Size', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  variant_name: string;
}
