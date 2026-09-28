import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Delivery fee per area. area "*" = everywhere else. */
@Entity('bot_delivery_zone')
export class BotDeliveryZone {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint' })
  company_id: number;

  @Column({ type: 'varchar', length: 120 })
  area: string;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  fee: number;

  @Column({ type: 'varchar', length: 120, default: '' })
  days: string;

  /** Optional weight rule: kg included in the base fee (null = flat fee) */
  @Column({ type: 'decimal', precision: 10, scale: 3, nullable: true })
  included_kg: number | null;

  /** Optional weight rule: fee for each kg above included_kg (exact kg, no rounding) */
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  per_extra_kg: number | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
