import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import type { BotOrderStatus } from '../entities/bot-order.entity';

export class UpdateOrderStatusDto {
  @IsIn(['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'])
  status: BotOrderStatus;

  /** false = change the status without sending the status message to the customer (default true) */
  @IsOptional()
  @IsBoolean()
  notify_customer?: boolean;
}
