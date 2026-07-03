import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { BotConversation } from './bot-conversation.entity';
import { BotCustomerLabel } from './bot-customer-label.entity';

@Entity('bot_conversation_label')
export class BotConversationLabel {
  @PrimaryColumn({ type: 'bigint' })
  conversation_id: number;

  @PrimaryColumn({ type: 'bigint' })
  label_id: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'assigned_at' })
  assigned_at: Date;

  @ManyToOne(() => BotConversation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: BotConversation;

  @ManyToOne(() => BotCustomerLabel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'label_id' })
  label: BotCustomerLabel;
}
