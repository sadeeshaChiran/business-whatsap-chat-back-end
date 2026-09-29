import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';

export class PackageDto {
  @IsString() @MinLength(2) @MaxLength(40) @Matches(/^[a-z0-9_-]+$/, { message: 'code: lowercase letters, numbers, - and _ only' })
  code: string;

  @IsString() @MinLength(1) @MaxLength(120)
  name: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @Type(() => Number) @IsNumber() @Min(0)
  price_monthly: number;

  @Type(() => Number) @IsNumber() @Min(0)
  price_yearly: number;

  @Type(() => Number) @IsInt() @Min(0)
  tokens_per_month: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  max_agents?: number | null;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  max_products?: number | null;

  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true })
  features?: string[];

  @IsOptional() @IsBoolean()
  is_active?: boolean;

  @IsOptional() @IsBoolean()
  is_public?: boolean;

  @IsOptional() @Type(() => Number) @IsInt()
  sort_order?: number;
}

export class UpdatePackageDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) price_monthly?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) price_yearly?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) tokens_per_month?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) max_agents?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) max_products?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) features?: string[];
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsBoolean() is_public?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sort_order?: number;
}

export class UpdateSubscriptionDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  package_id?: number;

  @IsOptional() @IsIn(['monthly', 'yearly'])
  billing_cycle?: 'monthly' | 'yearly';

  @IsOptional() @IsIn(['active', 'expired', 'suspended'])
  status?: 'active' | 'expired' | 'suspended';

  /** ISO date; null = never expires */
  @IsOptional() @IsString()
  period_end?: string | null;

  /** start a new token month now (usage count back to 0) */
  @IsOptional() @IsBoolean()
  reset_tokens?: boolean;
}

export class TokenAdjustmentDto {
  /** positive = extra tokens, negative = remove */
  @Type(() => Number) @IsInt()
  tokens: number;

  @IsString() @MinLength(2) @MaxLength(500)
  reason: string;

  /** temporary tokens: expire after this many days (empty = only this month) */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  expires_in_days?: number;
}

export class ListQueryDto {
  @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  days?: number;
}
