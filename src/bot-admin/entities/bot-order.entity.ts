import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BotChannelUser } from './bot-channel-user.entity';
import { BotOrderItem } from './bot-order-item.entity';
import { BotOrderStatusHistory } from './bot-order-status-history.entity';

export type BotOrderStatus =
  | 'Pending'
  | 'Confirmed'
  | 'Processing'
  | 'Shipped'
  | 'Delivered'
  | 'Cancelled';

@Entity('bot_order')
export class BotOrder {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  company_id: number;

  @Column({ type: 'int' })
  bot_channel_user_id: number;

  @Column({ type: 'varchar', length: 255, default: '' })
  customer_name: string;

  @Column({ type: 'varchar', length: 50, default: '' })
  customer_phone: string;

  @Column({ type: 'text', nullable: true })
  address: string | null;

  @Column({ type: 'enum', enum: ['Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'], default: 'Pending' })
  status: BotOrderStatus;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  total_amount: number;

  @Column({ type: 'text', nullable: true })
  invoice_url: string | null;

  @Column({ type: 'text', nullable: true })
  admin_note: string | null;

  /** Set by the sales bot (from bot_delivery_zone); included in total_amount */
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  delivery_fee: number | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  payment_method: string | null;

  /** Delivery zone area of a bot order (the fee is recalculated from it when the order changes) */
  @Column({ type: 'varchar', length: 120, nullable: true })
  delivery_area: string | null;

  /** Order weight (kg) used for the delivery fee (sales bot) */
  @Column({ type: 'decimal', precision: 10, scale: 3, nullable: true })
  total_weight_kg: number | null;

  @ManyToOne(() => BotChannelUser, { nullable: false, onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'bot_channel_user_id' })
  channelUser: BotChannelUser;

  @OneToMany(() => BotOrderItem, (item) => item.order)
  items: BotOrderItem[];

  @OneToMany(() => BotOrderStatusHistory, (history) => history.order)
  statusHistory: BotOrderStatusHistory[];

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp', name: 'updated_at' })
  updated_at: Date;
}
