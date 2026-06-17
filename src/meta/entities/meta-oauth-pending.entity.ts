import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('meta_oauth_pending')
export class MetaOauthPending {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint', unique: true })
  company_id: number;

  @Column({ type: 'text', default: '' })
  meta_user_id: string;

  @Column({ type: 'jsonb', default: [] })
  pages_json: MetaPendingPage[];

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;
}

export type MetaPendingPage = {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account_id?: string | null;
};
