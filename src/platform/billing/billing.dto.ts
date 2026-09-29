import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CheckoutDto {
  @IsIn(['subscription', 'token_pack'])
  kind: 'subscription' | 'token_pack';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  package_id?: number;

  @IsOptional() @IsIn(['monthly', 'yearly'])
  billing_cycle?: 'monthly' | 'yearly';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  token_pack_id?: number;

  @IsIn(['payhere', 'bank_transfer'])
  method: 'payhere' | 'bank_transfer';

  /** PayHere only: renew automatically every month / year */
  @IsOptional() @IsBoolean()
  auto_renew?: boolean;
}

export class AutoRenewDto {
  @IsBoolean()
  enabled: boolean;
}

export class RejectPaymentDto {
  @IsString() @MinLength(3) @MaxLength(500)
  reason: string;
}

export class BankDetailsDto {
  @IsString() @MaxLength(120) bank_name: string;
  @IsString() @MaxLength(120) branch: string;
  @IsString() @MaxLength(120) account_name: string;
  @IsString() @MaxLength(60) account_number: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class TokenPackDto {
  @IsString() @MinLength(1) @MaxLength(120) name: string;
  @Type(() => Number) @IsInt() @Min(1) tokens: number;
  @Type(() => Number) @IsNumber() @Min(0) price: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) valid_days?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sort_order?: number;
}

export class PaymentsQueryDto {
  @IsOptional() @IsIn(['pending', 'awaiting_approval', 'paid', 'rejected', 'failed', 'cancelled'])
  status?: string;
}
