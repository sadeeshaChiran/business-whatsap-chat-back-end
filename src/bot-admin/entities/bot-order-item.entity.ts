import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { BotOrder } from './bot-order.entity';

@Entity('bot_order_item')
export class BotOrderItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  order_id: number;

  @Column({ type: 'int', nullable: true })
  product_id: number | null;

  @Column({ type: 'varchar', length: 255 })
  product_name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  variant_text: string | null;

  @Column({ type: 'int', default: 1 })
  quantity: number;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  unit_price: number;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  total_price: number;

  @ManyToOne(() => BotOrder, (order) => order.items, { nullable: false, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: BotOrder;

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at: Date;
}
