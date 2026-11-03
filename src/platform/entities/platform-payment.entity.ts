import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type PaymentKind = 'subscription' | 'token_pack' | 'sms_pack';
export type PaymentMethod = 'payhere' | 'bank_transfer' | 'manual' | 'paypal' | 'paymentslk';
/**
 * pending            – created, waiting for PayHere or for the bank slip
 * awaiting_approval  – bank slip uploaded, super admin must check it
 * paid / rejected / failed / cancelled
 */
export type PaymentStatus = 'pending' | 'awaiting_approval' | 'paid' | 'rejected' | 'failed' | 'cancelled' | 'refunded';

@Entity('platform_payment')
export class PlatformPayment {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint' })
  company_id: number;

  @Column({ type: 'varchar', length: 20 })
  kind: PaymentKind;

  @Column({ type: 'int', nullable: true })
  package_id: number | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  billing_cycle: 'monthly' | 'yearly' | null;

  @Column({ type: 'int', nullable: true })
  token_pack_id: number | null;

  /** Agent Metra SMS credits */
  @Column({ type: 'int', nullable: true })
  sms_pack_id: number | null;

  /** SMS credits promised at checkout */
  @Column({ type: 'int', nullable: true })
  sms_credits: number | null;

  @Column({ type: 'varchar', length: 255, default: '' })
  description: string;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount: number;

  @Column({ type: 'varchar', length: 3, default: 'LKR' })
  currency: string;

  @Column({ type: 'varchar', length: 20 })
  method: PaymentMethod;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: PaymentStatus;

  @Column({ type: 'boolean', default: false })
  auto_renew: boolean;

  /** sent to PayHere as order_id */
  @Column({ type: 'varchar', length: 60, unique: true })
  order_id: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  payhere_payment_id: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  payhere_subscription_id: string | null;

  /** PayPal: charged in US dollars at the rate of the day (amount stays in rupees) */
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  amount_usd: string | number | null;

  @Column({ type: 'decimal', precision: 12, scale: 4, nullable: true })
  usd_rate: string | number | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  paypal_order_id: string | null;

  @Column({ type: 'varchar', length: 60, nullable: true })
  paypal_subscription_id: string | null;

  /** the PayPal capture / sale id of the money (one per payment) */
  @Column({ type: 'varchar', length: 60, nullable: true })
  paypal_payment_id: string | null;

  /** Payments.lk: hosted checkout, the payment (money) and the card saved for auto-renew */
  @Column({ type: 'varchar', length: 80, nullable: true })
  plk_checkout_id: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  plk_payment_id: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  plk_card_id: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  slip_media_key: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  slip_file_name: string | null;

  @Column({ type: 'text', default: '' })
  note: string;

  @Column({ type: 'text', nullable: true })
  reject_reason: string | null;

  @Column({ type: 'bigint', nullable: true })
  reviewed_by_user_id: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewed_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  paid_at: Date | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  invoice_no: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  invoice_media_key: string | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_user_id: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
