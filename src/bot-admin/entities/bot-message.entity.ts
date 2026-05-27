import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BotConversation } from './bot-conversation.entity';

@Entity('bot_message')
export class BotMessage {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  conversation_id: number;

  @Column({ type: 'enum', enum: ['inbound', 'outbound'] })
  direction: 'inbound' | 'outbound';

  @Column({ type: 'enum', enum: ['text', 'image', 'voice', 'system'] })
  message_type: 'text' | 'image' | 'voice' | 'system';

  @Column({ type: 'varchar', length: 30 })
  platform: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'text', nullable: true })
  media_url: string | null;

  @Column({ type: 'text', nullable: true })
  transcript: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  llm_provider: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  llm_model: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  intent: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  sentiment: string | null;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  trouble_score: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  source: string | null;

  @ManyToOne(() => BotConversation, (conversation) => conversation.messages, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'conversation_id' })
  conversation: BotConversation;

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp', name: 'updated_at' })
  updated_at: Date;
}
