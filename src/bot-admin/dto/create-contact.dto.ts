import { IsNotEmpty, IsString, MaxLength, Matches } from 'class-validator';

export class CreateContactDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  display_name: string;

  @IsString()
  @Matches(/^\+?[0-9]{7,15}$/, { message: 'Enter a valid WhatsApp phone number.' })
  phone: string;
}
