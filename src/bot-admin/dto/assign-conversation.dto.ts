import { IsInt, Min } from 'class-validator';

export class AssignConversationDto {
  @IsInt()
  @Min(1)
  agent_id: number;
}
