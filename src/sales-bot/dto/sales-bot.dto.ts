import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BOT_BOOKING_STATUSES, type BotBookingStatus } from '../entities/bot-booking.entity';

export const SALES_BOT_LANGUAGES = ['auto', 'sinhala', 'sinhala_latin', 'tamil', 'english'] as const;

/* ───────── Services ───────── */

export class CreateBotServiceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  price_note?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  duration_min?: number | null;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  /** Available / Unavailable right now (the bot says “not available now”) */
  @IsOptional()
  @IsBoolean()
  is_available?: boolean;
}

export class UpdateBotServiceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  price_note?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  duration_min?: number | null;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  /** Available / Unavailable right now (the bot says “not available now”) */
  @IsOptional()
  @IsBoolean()
  is_available?: boolean;
}

/* ───────── Delivery zones ───────── */

export class CreateDeliveryZoneDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  area: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  fee: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  days?: string;

  /** Weight rule (optional): kg included in the base fee. Empty = flat fee. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  included_kg?: number | null;

  /** Weight rule (optional): fee for each extra kg (exact kg). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  per_extra_kg?: number | null;
}

export class UpdateDeliveryZoneDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  area?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  fee?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  days?: string;

  /** Weight rule (optional): kg included in the base fee. Empty = flat fee. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  included_kg?: number | null;

  /** Weight rule (optional): fee for each extra kg (exact kg). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  per_extra_kg?: number | null;
}

/* ───────── Bookings ───────── */

export class UpdateBookingStatusDto {
  @IsIn(BOT_BOOKING_STATUSES)
  status: BotBookingStatus;
}

export class BookingsQueryDto {
  @IsOptional()
  @IsIn(BOT_BOOKING_STATUSES)
  status?: BotBookingStatus;
}

/* ───────── Settings ───────── */

export class UpdateSalesBotSettingsDto {
  @IsOptional()
  @IsBoolean()
  bot_enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  bot_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  tone?: string;

  @IsOptional()
  @IsIn(SALES_BOT_LANGUAGES as unknown as string[])
  default_language?: string;

  @IsOptional()
  @IsString()
  greeting?: string;

  @IsOptional()
  @IsString()
  about?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  opening_hours?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  payment_methods?: string;

  @IsOptional()
  @IsBoolean()
  auto_enable_new_customers?: boolean;

  /** auto (from the business category) | products | services | both */
  @IsOptional()
  @IsIn(['auto', 'products', 'services', 'both'])
  sells?: string;

  @IsOptional()
  @IsBoolean()
  auto_send_invoice?: boolean;

  @IsOptional()
  @IsBoolean()
  bot_off_on_handoff?: boolean;
}

/* ───────── Test chat ───────── */

export class SalesBotTurnDto {
  @IsIn(['customer', 'bot'])
  role: 'customer' | 'bot';

  @IsString()
  text: string;
}

export class SalesBotTestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalesBotTurnDto)
  history?: SalesBotTurnDto[];

  /** { language?, pending_order? } – passed to the bot as-is */
  @IsOptional()
  @IsObject()
  session?: Record<string, unknown>;
}

/* ───────── Customer simulator (multipart form) ───────── */

export class SimulateCustomerMessageDto {
  @IsString()
  @MinLength(9)
  @MaxLength(20)
  phone: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  text?: string;
}

export class SimulatorConversationQueryDto {
  @IsString()
  phone: string;
}

/* ───────── Replies / reports ───────── */

export class RepliesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @IsIn(['handoff'])
  only?: 'handoff';
}

export class ReportQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  days?: number;
}
