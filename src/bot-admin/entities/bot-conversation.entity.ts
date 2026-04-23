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

  @Column()
  bot_channel_user_id: number;

  @Column({ type: 'enum', enum: ['open', 'manual', 'closed'], default: 'open' })
  status: 'open' | 'manual' | 'closed';

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
