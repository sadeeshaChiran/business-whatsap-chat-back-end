import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class ConnectWhatsappEmbeddedDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  /** From Meta's browser message. Optional: when it was lost, the server finds the account from the code. */
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  waba_id?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  phone_number_id?: string;

  /** The dashboard page the Meta popup was opened from (used for the code swap when Meta needs a redirect_uri). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  page_url?: string;
}
