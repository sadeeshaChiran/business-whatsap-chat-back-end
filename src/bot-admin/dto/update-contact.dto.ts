import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UpdateContactDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  display_name: string;
}
