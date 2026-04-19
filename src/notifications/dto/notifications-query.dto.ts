import { IsIn, IsOptional } from 'class-validator';

export class NotificationsQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  unread?: 'true' | 'false';

  @IsOptional()
  @IsIn(['REMINDER', 'RISK', 'INFO'])
  type?: 'REMINDER' | 'RISK' | 'INFO';
}
