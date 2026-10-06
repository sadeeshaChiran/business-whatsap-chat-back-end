import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** A package sold by Metrocoding (managed by the super admin). code is stored in companies.plan. */
@Entity('platform_package')
export class PlatformPackage {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 40, unique: true })
  code: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  price_monthly: number;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  price_yearly: number;

  /** Offer price per month (null = no offer). Charged until offer_until (Sri Lanka date, inclusive). */
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  offer_price_monthly: number | null;

  /** Offer price per year (null = yearly is always the normal price) */
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  offer_price_yearly: number | null;

  /** Last day of the offer, YYYY-MM-DD (null = no offer) */
  @Column({ type: 'date', nullable: true })
  offer_until: string | null;

  /** Short text on the price card, e.g. "Launch offer" */
  @Column({ type: 'varchar', length: 80, default: '' })
  offer_label: string;

  /** AI tokens per month (tokens reset monthly, also on yearly plans) */
  @Column({ type: 'bigint', default: 0 })
  tokens_per_month: number;

  /** null = unlimited */
  @Column({ type: 'int', nullable: true })
  max_agents: number | null;

  /** null = unlimited */
  @Column({ type: 'int', nullable: true })
  max_products: number | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  features: string[];

  /** Feature switches and numbers (see package-limits.ts), editable by the super admin */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  limits: Record<string, boolean | number | null>;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  /** shown on the pricing page and to companies */
  @Column({ type: 'boolean', default: true })
  is_public: boolean;

  @Column({ type: 'int', default: 0 })
  sort_order: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
