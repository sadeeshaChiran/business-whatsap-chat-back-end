import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Per-company sales bot settings. Bot on/off itself is companies.bot_enabled (Free plan rule). */
@Entity('bot_sales_settings')
export class SalesBotSettings {
  @PrimaryColumn({ type: 'bigint' })
  company_id: number;

  @Column({ type: 'varchar', length: 100, default: '' })
  bot_name: string;

  @Column({ type: 'varchar', length: 255, default: 'friendly, short, helpful' })
  tone: string;

  @Column({ type: 'varchar', length: 30, default: 'auto' })
  default_language: string;

  @Column({ type: 'text', default: '' })
  greeting: string;

  @Column({ type: 'text', default: '' })
  about: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  opening_hours: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  payment_methods: string;

  /** New customers get the bot automatically unless an agent switched it off for them. */
  @Column({ type: 'boolean', default: true })
  auto_enable_new_customers: boolean;

  /** auto (from the business category) | products | services | both */
  @Column({ type: 'varchar', length: 20, default: 'auto' })
  sells: string;

  /** Send the invoice PDF automatically when the bot saves an order */
  @Column({ type: 'boolean', default: true })
  auto_send_invoice: boolean;

  /** false (default) = keep replying when a person is needed (note + notification); true = switch the bot off */
  @Column({ type: 'boolean', default: false })
  bot_off_on_handoff: boolean;

  /** Follow up interested customers who stopped replying (up to 2 messages, inside the 24-hour chat window) */
  @Column({ type: 'boolean', default: true })
  followup_enabled: boolean;

  /** hours after the customer's last message for follow-up 1 */
  @Column({ type: 'numeric', precision: 5, scale: 2, default: 3, transformer: { to: (v: number) => v, from: (v: string | number) => Number(v) } })
  followup_first_hours: number;

  /** hours after the customer's last message for follow-up 2 (0 = only one follow-up) */
  @Column({ type: 'numeric', precision: 5, scale: 2, default: 22, transformer: { to: (v: number) => v, from: (v: string | number) => Number(v) } })
  followup_second_hours: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
