import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SendConversationMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text: string;
}
