import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
@Entity({ name: 'companies', database: 'supabase' })
export class SupabaseCompany {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ name: 'company_name', type: 'text' })
  name: string;

  @Column({ type: 'text', default: 'ACTIVE' })
  status: string;

  @Column({ type: 'text', default: '' })
  plan: string;

  @Column({ type: 'text', default: '' })
  email: string;

  @Column({ type: 'text', default: '' })
  phone: string;

  @Column({ type: 'text', default: '' })
  address: string;

  @Column({ type: 'bigint', nullable: true })
  admin_user_id: number | null;

  @Column({ type: 'bigint', nullable: true })
  industry_id: number | null;

  @Column({ type: 'boolean', default: true })
  is_email_nofications: boolean;

  @Column({ type: 'boolean', default: true })
  is_weekly_report: boolean;

  @Column({ type: 'boolean', default: true })
  is_monthly_report: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
