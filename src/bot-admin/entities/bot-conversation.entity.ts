import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BotChannelUser } from './bot-channel-user.entity';
import { BotFlag } from './bot-flag.entity';
import { BotMessage } from './bot-message.entity';

@Entity('bot_conversation')
export class BotConversation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  bot_channel_user_id: number;

  /**
   * open     = unassigned bot chat
   * pending  = assigned to agent, waiting for agent to accept
   * active   = agent accepted and is handling
   * manual   = manual mode (legacy)
   * closed   = conversation closed
   */
  @Column({ type: 'varchar', length: 20, default: 'open' })
  status: 'open' | 'pending' | 'active' | 'manual' | 'closed';

  @Column({ type: 'int', nullable: true })
  assigned_agent_id: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  assigned_at: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  last_message_at: Date | null;

  @ManyToOne(() => BotChannelUser, (channelUser) => channelUser.conversations, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'bot_channel_user_id' })
  channelUser: BotChannelUser;

  @OneToMany(() => BotMessage, (message) => message.conversation)
  messages: BotMessage[];

  @OneToMany(() => BotFlag, (flag) => flag.conversation)
  flags: BotFlag[];

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp', name: 'updated_at' })
  updated_at: Date;
}
