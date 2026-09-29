import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Key-value settings managed by the super admin (e.g. bank_details). */
@Entity('platform_setting')
export class PlatformSetting {
  @PrimaryColumn({ type: 'varchar', length: 60 })
  key: string;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  value: Record<string, unknown>;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
