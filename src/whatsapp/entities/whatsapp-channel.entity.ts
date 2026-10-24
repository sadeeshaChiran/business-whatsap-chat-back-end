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

  @Column({ type: 'boolean', nullable: true })
  evolution_read_messages: boolean | null;

  /** Name the shop gives the number, e.g. "Wholesale" (several numbers per company) */
  @Column({ type: 'text', nullable: true })
  label: string | null;

  /** What the number is for: sales / support / wholesale / ads / delivery / other */
  @Column({ type: 'varchar', length: 30, nullable: true })
  purpose: string | null;

  /** Extra instructions for the AI bot when a customer writes to this number */
  @Column({ type: 'text', nullable: true })
  bot_note: string | null;

  /** false = the AI bot does not answer on this number (the team answers) */
  @Column({ type: 'boolean', default: true })
  bot_enabled: boolean;

  /** The company's main number: Settings, broadcasts and new chats started by the team use it */
  @Column({ type: 'boolean', default: false })
  is_primary: boolean;

  @Column({ type: 'varchar', length: 40, nullable: true })
  display_phone: string | null;

  @Column({ type: 'text', nullable: true })
  verified_name: string | null;
}

