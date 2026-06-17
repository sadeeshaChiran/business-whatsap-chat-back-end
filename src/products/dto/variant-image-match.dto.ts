import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsObject, IsString } from 'class-validator';

export class VariantImageMatchDto {
  @ApiProperty({
    example: ['Color'],
    description: 'Variant option names used to match images (e.g. Color only, or Color + Size).',
  })
  @IsArray()
  @IsString({ each: true })
  dimensions: string[];

  @ApiProperty({
    example: { Red: 'https://cdn.example.com/red.jpg', Blue: 'https://cdn.example.com/blue.jpg' },
    description: 'Map of dimension value key to image URL (key is values joined with " / ").',
  })
  @IsObject()
  images: Record<string, string>;
}
