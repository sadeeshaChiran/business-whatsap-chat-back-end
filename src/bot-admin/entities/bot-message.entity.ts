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

  @Column({ type: 'varchar', length: 255, nullable: true })
  provider_message_id: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  delivery_status: 'sent' | 'delivered' | 'read' | 'failed' | null;

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

  /** the earlier message this one replies to (WhatsApp / Messenger quote) */
  @Column({ type: 'int', nullable: true })
  reply_to_message_id: number | null;

  /** provider id of the quoted message (kept even when that message is not in our database) */
  @Column({ type: 'varchar', length: 160, nullable: true })
  reply_to_provider_id: string | null;

  /** short copy of the quoted text (shown above the message and sent to the AI) */
  @Column({ type: 'text', nullable: true })
  reply_to_text: string | null;

  /** owner feedback on a bot reply: up | down (inbox thumbs) */
  @Column({ type: 'varchar', length: 8, nullable: true })
  feedback: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  feedback_at: Date | null;

  @Column({ type: 'int', nullable: true })
  feedback_by: number | null;

  /** the training row (style example / wrong reply) made from this feedback */
  @Column({ type: 'int', nullable: true })
  feedback_training_id: number | null;

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
