import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** Owner feedback on a sales bot reply (inbox 👍 / 👎). */
export class MessageFeedbackDto {
  /** up = good reply (saved as a style example), down = wrong reply, none = remove the feedback */
  @IsIn(['up', 'down', 'none'])
  rating: 'up' | 'down' | 'none';

  /** with "down": the reply the bot should have sent (saved as a style example instead) */
  @IsOptional()
  @IsString()
  @MaxLength(1500)
  better_reply?: string;
}
