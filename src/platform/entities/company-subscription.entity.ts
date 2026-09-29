import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type BillingCycle = 'monthly' | 'yearly';
export type SubscriptionStatus = 'active' | 'expired' | 'suspended';

/** The company's current package. Tokens reset every month (token_period_*). */
@Entity('company_subscription')
export class CompanySubscription {
  @PrimaryColumn({ type: 'bigint' })
  company_id: number;

  @Column({ type: 'int' })
  package_id: number;

  @Column({ type: 'varchar', length: 10, default: 'monthly' })
  billing_cycle: BillingCycle;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: SubscriptionStatus;

  @Column({ type: 'timestamptz' })
  period_start: Date;

  /** null = never expires (Free) */
  @Column({ type: 'timestamptz', nullable: true })
  period_end: Date | null;

  @Column({ type: 'timestamptz' })
  token_period_start: Date;

  @Column({ type: 'timestamptz' })
  token_period_end: Date;

  @Column({ type: 'timestamptz', nullable: true })
  warned_80_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  warned_100_at: Date | null;

  /** PayHere recurring payments renew the package automatically */
  @Column({ type: 'boolean', default: false })
  auto_renew: boolean;

  @Column({ type: 'varchar', length: 60, nullable: true })
  payhere_subscription_id: string | null;

  /** renewal reminders (bank transfer / no auto-renew) */
  @Column({ type: 'timestamptz', nullable: true })
  reminded_7_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  reminded_1_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
