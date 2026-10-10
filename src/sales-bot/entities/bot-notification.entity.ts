import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type BotNotificationKind =
  | 'special_note' | 'order_changed' | 'change_request' | 'order_cancelled' | 'cancel_request' | 'new_order' | 'handoff'
  | 'booking_changed' | 'booking_cancelled';

/** An alert for the team from the sales bot (shown in the Notifications feed). */
@Entity('bot_notification')
export class BotNotification {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint' })
  company_id: number;

  @Column({ type: 'varchar', length: 30 })
  kind: BotNotificationKind;

  /** LOW | MEDIUM | HIGH */
  @Column({ type: 'varchar', length: 10, default: 'MEDIUM' })
  priority: 'LOW' | 'MEDIUM' | 'HIGH';

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', default: '' })
  message: string;

  @Column({ type: 'int', nullable: true })
  conversation_id: number | null;

  @Column({ type: 'int', nullable: true })
  order_id: number | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;
}
