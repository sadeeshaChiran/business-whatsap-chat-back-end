import { IsNumber, IsString, MinLength } from 'class-validator';

export class CreateBotCustomerNoteDto {
  @IsNumber()
  bot_channel_user_id: number;

  @IsString()
  @MinLength(1)
  content: string;
}
