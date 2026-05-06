import { IsIn, IsString, MinLength } from 'class-validator';
import type { BotOrderStatus } from '../entities/bot-order.entity';

export class UpdateStatusTemplateDto {
  @IsIn(['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'])
  status: BotOrderStatus;

  @IsString()
  @MinLength(3)
  template: string;
}
