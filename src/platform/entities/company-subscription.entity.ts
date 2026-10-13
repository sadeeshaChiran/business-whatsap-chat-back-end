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

  /** free trial of a package: when period_end passes the company moves to fallback_package_id (Free) */
  @Column({ type: 'boolean', default: false })
  is_trial: boolean;

  @Column({ type: 'varchar', length: 200, nullable: true })
  trial_note: string | null;

  @Column({ type: 'int', nullable: true })
  fallback_package_id: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  trial_reminded_at: Date | null;

  /** end of the free AI-bot days of a package with bot_days (set once, the first time the company gets such a package) */
  @Column({ type: 'timestamptz', nullable: true })
  bot_free_until: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  bot_free_reminded_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
