import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** Quick switch: { "available": false } or { "available": true, "variant_value": "Red / M" } */
export class ProductAvailabilityDto {
  @IsBoolean() available: boolean;
  @IsOptional() @IsString() @MaxLength(200) variant_value?: string;
}
