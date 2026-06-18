import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsObject, IsString } from 'class-validator';

export class VariantPriceMatchDto {
  @ApiProperty({
    example: ['Size'],
    description:
      'Variant option names used to match prices (e.g. Size only, or Color + Size).',
  })
  @IsArray()
  @IsString({ each: true })
  dimensions: string[];

  @ApiProperty({
    example: { '12-24 Months': 1850, '0-6 Months': 1650 },
    description:
      'Map of dimension value key to price (key is values joined with " / ").',
  })
  @IsObject()
  prices: Record<string, number>;
}
