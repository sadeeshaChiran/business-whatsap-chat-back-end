import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BotOrder, type BotOrderStatus } from './bot-order.entity';

@Entity('bot_order_status_history')
export class BotOrderStatusHistory {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  order_id: number;

  @Column({ type: 'enum', enum: ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'] })
  status: BotOrderStatus;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  @ManyToOne(() => BotOrder, (order) => order.statusHistory, { nullable: false, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: BotOrder;

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at: Date;
}
