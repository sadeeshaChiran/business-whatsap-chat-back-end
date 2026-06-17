import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('meta_page_connections')
export class MetaPageConnection {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  company_id: number;

  @Column({ type: 'text', nullable: true })
  company_name: string | null;

  @Column({ type: 'text', default: '' })
  meta_user_id: string;

  @Column({ type: 'text' })
  page_id: string;

  @Column({ type: 'text', default: '' })
  page_name: string;

  @Column({ type: 'text' })
  page_access_token: string;

  @Column({ type: 'text', nullable: true })
  instagram_business_account_id: string | null;

  @Column({ type: 'text', default: 'CONNECTED' })
  status: string;

  @Column({ type: 'timestamptz', nullable: true })
  token_expires_at: Date | null;

  @Column({ type: 'text', nullable: true })
  scopes: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_synced_at: Date | null;

  @Column({ type: 'text', nullable: true })
  last_error: string | null;

  @Column({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @Column({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
