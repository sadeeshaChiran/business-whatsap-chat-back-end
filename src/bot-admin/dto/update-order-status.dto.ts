import { IsIn } from 'class-validator';
import type { BotOrderStatus } from '../entities/bot-order.entity';

export class UpdateOrderStatusDto {
  @IsIn(['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'])
  status: BotOrderStatus;
}
