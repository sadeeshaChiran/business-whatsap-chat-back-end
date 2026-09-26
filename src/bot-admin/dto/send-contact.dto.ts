import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class SendContactDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name: string;

  /** International format, e.g. +94771234567 */
  @IsString() @Matches(/^\+?[\d\s-]{7,20}$/, { message: 'phone must be a valid phone number with country code' })
  phone: string;

  @IsOptional() @IsString() @MaxLength(120)
  company?: string;
}
