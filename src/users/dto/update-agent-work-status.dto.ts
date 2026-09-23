import { IsIn, IsString } from 'class-validator';

export class UpdateAgentWorkStatusDto {
  @IsString()
  @IsIn(['online', 'offline', 'no_need'])
  status: 'online' | 'offline' | 'no_need';
}
