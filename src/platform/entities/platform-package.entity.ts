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
