import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Extra (or removed) tokens from the super admin.
 * Temporary (expires_at set): counts until it expires.
 * Without expires_at: counts only in the month it was given.
 */
@Entity('token_adjustment')
export class TokenAdjustment {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint' })
  company_id: number;

  @Column({ type: 'bigint' })
  tokens: number;

  @Column({ type: 'text', default: '' })
  reason: string;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at: Date | null;

  @Column({ type: 'bigint', nullable: true })
  created_by_user_id: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
