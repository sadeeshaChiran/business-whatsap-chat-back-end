import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('app_user')
@Unique('UQ_users_email', ['email'])
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  email: string;

  @Column({ type: 'varchar', length: 255 })
  password_hash: string;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @Column({ type: 'bigint', nullable: true })
  company_id: number | null;

  @Column({ type: 'boolean', default: false })
  is_agent_active: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  email_verified_at: Date | null;

  /** The admin's own WhatsApp number (verified with a code) */
  @Column({ type: 'varchar', length: 20, nullable: true })
  whatsapp_number: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  whatsapp_verified_at: Date | null;

  /** Metrocoding team (Agent Metra platform admin) */
  @Column({ type: 'boolean', default: false })
  is_super_admin: boolean;

  /** Raised on password change / reset / removed access – older login tokens stop working */
  @Column({ type: 'int', default: 0 })
  token_version: number;

  /** The company admin removed this agent's access – login is refused */
  @Column({ type: 'boolean', default: false })
  access_disabled: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  last_login_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  password_changed_at: Date | null;

  @Column({ type: 'int', default: 0, select: false })
  failed_login_count: number;

  @Column({ type: 'timestamptz', nullable: true, select: false })
  locked_until: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
