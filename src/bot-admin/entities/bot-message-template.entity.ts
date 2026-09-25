import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type BotTemplateButton = { label: string; url?: string; payload?: string };

@Entity('bot_message_template')
export class BotMessageTemplate {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint' })
  company_id: number;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 160, default: '' })
  title: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'text', nullable: true })
  image_url: string | null;

  @Column({ type: 'jsonb', default: [] })
  buttons: BotTemplateButton[];

  @Column({ type: 'jsonb', default: ['messenger', 'instagram'] })
  platforms: string[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
