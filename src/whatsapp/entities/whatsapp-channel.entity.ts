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
}

