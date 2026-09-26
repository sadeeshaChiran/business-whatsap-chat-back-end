import { IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

export class SendLocationDto {
  @Type(() => Number) @IsNumber() @IsLatitude()
  latitude: number;

  @Type(() => Number) @IsNumber() @IsLongitude()
  longitude: number;

  @IsOptional() @IsString() @MaxLength(200)
  name?: string;

  @IsOptional() @IsString() @MaxLength(500)
  address?: string;
}
