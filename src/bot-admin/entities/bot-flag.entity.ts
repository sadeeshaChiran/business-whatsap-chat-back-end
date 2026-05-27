import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BotChannelUser } from './bot-channel-user.entity';
import { BotConversation } from './bot-conversation.entity';

@Entity('bot_flag')
export class BotFlag {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  conversation_id: number;

  @Column({ name: 'bot_channel_user_id', type: 'int' })
  bot_channel_user_id: number;

  @Column({ type: 'varchar', length: 50 })
  flag_type: 'anger' | 'confusion' | 'repeated_failure' | 'manual_handoff';

  @Column({ type: 'varchar', length: 20 })
  severity: 'low' | 'medium' | 'high';

  @Column({ type: 'text' })
  reason: string;

  @Column({ type: 'boolean', default: false })
  resolved: boolean;

  @ManyToOne(() => BotConversation, (conversation) => conversation.flags, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'conversation_id' })
  conversation: BotConversation;

  @ManyToOne(() => BotChannelUser, (channelUser) => channelUser.flags, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'bot_channel_user_id' })
  channelUser: BotChannelUser;

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp', name: 'updated_at' })
  updated_at: Date;
}
