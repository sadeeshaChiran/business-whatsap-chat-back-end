import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

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
}
