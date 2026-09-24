import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class ConnectWhatsappEmbeddedDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @Matches(/^\d+$/)
  waba_id: string;

  @IsString()
  @Matches(/^\d+$/)
  phone_number_id: string;
}
