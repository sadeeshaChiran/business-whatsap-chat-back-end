import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type BotBookingStatus = 'requested' | 'confirmed' | 'done' | 'cancelled';
export const BOT_BOOKING_STATUSES: BotBookingStatus[] = ['requested', 'confirmed', 'done', 'cancelled'];

/** A booking the sales bot collected in chat. */
@Entity('bot_booking')
export class BotBooking {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint' })
  company_id: number;

  @Column({ type: 'int', nullable: true })
  bot_channel_user_id: number | null;

  @Column({ type: 'int', nullable: true })
  conversation_id: number | null;

  @Column({ type: 'int', nullable: true })
  service_id: number | null;

  @Column({ type: 'varchar', length: 255 })
  service_name: string;

  @Column({ type: 'varchar', length: 40, default: '' })
  date: string;

  @Column({ type: 'varchar', length: 40, default: '' })
  time: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  customer_name: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  customer_phone: string | null;

  @Column({ type: 'text', default: '' })
  notes: string;

  @Column({ type: 'varchar', length: 20, default: 'requested' })
  status: BotBookingStatus;

  /** service price and length when booked (for the booking invoice) */
  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true, transformer: { to: (v: number | null) => v, from: (v: string | number | null) => (v == null ? null : Number(v)) } })
  price: number | null;

  @Column({ type: 'int', nullable: true })
  duration_min: number | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  invoice_url: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
