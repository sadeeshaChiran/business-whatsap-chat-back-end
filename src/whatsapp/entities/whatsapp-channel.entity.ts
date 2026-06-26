import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('whatsapp_channels')
export class WhatsappChannel {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  company_id: number;

  @Column({ type: 'text', nullable: true })
  company_name: string | null;

  @Column({ type: 'text', default: 'general' })
  role_type: string;

  @Column({ type: 'text' })
  instance_name: string;

  /** Evolution API instance label; kept when provider_type is meta for dual webhook routing. */
  @Column({ type: 'text', nullable: true })
  evolution_instance_name: string | null;

  @Column({ type: 'text', default: 'DISCONNECTED' })
  status: string;

  @Column({ type: 'int', default: 1 })
  weight: number;

  @Column({ type: 'timestamptz', nullable: true })
  last_used_at: Date | null;

  @Column({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @Column({ type: 'text', nullable: true })
  evaluation_whatsapp_key: string | null;

  @Column({ type: 'varchar', length: 20, default: 'evolution' })
  provider_type: 'evolution' | 'meta';

  @Column({ type: 'varchar', length: 64, nullable: true })
  meta_phone_number_id: string | null;

  @Column({ type: 'text', nullable: true })
  meta_access_token: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  meta_waba_id: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  meta_verify_token: string | null;

  @Column({ type: 'text', nullable: true })
  evolution_api_base: string | null;

  @Column({ type: 'text', nullable: true })
  meta_webhook_base_url: string | null;
}

