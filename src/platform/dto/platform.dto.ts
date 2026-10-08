import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

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

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  max_services?: number | null;

  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true })
  features?: string[];

  /** Feature switches / numbers – see package-limits.ts (unknown keys are ignored) */
  @IsOptional() @IsObject()
  limits?: Record<string, boolean | number | null>;

  @IsOptional() @IsBoolean()
  is_active?: boolean;

  @IsOptional() @IsBoolean()
  is_public?: boolean;

  @IsOptional() @Type(() => Number) @IsInt()
  sort_order?: number;

  /** Offer price per month - null clears it. Must be lower than the normal price. */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Number) @IsNumber() @Min(0) offer_price_monthly?: number | null;
  /** Offer price per year - null clears it (leave empty: a yearly plan bought on offer runs past the offer date). */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Number) @IsNumber() @Min(0) offer_price_yearly?: number | null;
  /** Last day of the offer (Sri Lanka date, YYYY-MM-DD) - null ends the offer */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'offer_until must be a date like 2026-12-31' }) offer_until?: string | null;
  @IsOptional() @IsString() @MaxLength(80) offer_label?: string;
}

export class UpdatePackageDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) price_monthly?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) price_yearly?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) tokens_per_month?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) max_agents?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) max_products?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) max_services?: number | null;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) features?: string[];
  @IsOptional() @IsObject() limits?: Record<string, boolean | number | null>;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsBoolean() is_public?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sort_order?: number;

  /** Offer price per month - null clears it. Must be lower than the normal price. */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Number) @IsNumber() @Min(0) offer_price_monthly?: number | null;
  /** Offer price per year - null clears it (leave empty: a yearly plan bought on offer runs past the offer date). */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Type(() => Number) @IsNumber() @Min(0) offer_price_yearly?: number | null;
  /** Last day of the offer (Sri Lanka date, YYYY-MM-DD) - null ends the offer */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'offer_until must be a date like 2026-12-31' }) offer_until?: string | null;
  @IsOptional() @IsString() @MaxLength(80) offer_label?: string;
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

export class CreditSettingsDto {
  /** 1 credit = this many AI tokens */
  @Type(() => Number) @IsInt() @Min(1000)
  tokens_per_credit: number;

  /** average tokens per bot reply - only used for the "≈ N AI replies" text on packages */
  @IsOptional() @Type(() => Number) @IsInt() @Min(500) @Max(200_000)
  tokens_per_reply?: number;
}
