import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type PaymentKind = 'subscription' | 'token_pack';
export type PaymentMethod = 'payhere' | 'bank_transfer' | 'manual';
/**
 * pending            – created, waiting for PayHere or for the bank slip
 * awaiting_approval  – bank slip uploaded, super admin must check it
 * paid / rejected / failed / cancelled
 */
export type PaymentStatus = 'pending' | 'awaiting_approval' | 'paid' | 'rejected' | 'failed' | 'cancelled';

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
