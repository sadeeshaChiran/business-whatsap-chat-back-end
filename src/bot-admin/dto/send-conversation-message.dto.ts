import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class SendConversationMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text: string;

  /** reply to (quote) this earlier message of the same chat */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  reply_to_message_id?: number;

  /** the team read the ban-safety warning and sends anyway */
  @IsOptional()
  @IsBoolean()
  confirm_risk?: boolean;
}
