import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BotChannelUser } from './bot-channel-user.entity';

@Entity('bot_customer_note')
export class BotCustomerNote {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  company_id: number;

  @Column({ type: 'int' })
  bot_channel_user_id: number;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'bigint', nullable: true })
  created_by_user_id: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  created_by_name: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sent_at: Date | null;

  @Column({ type: 'boolean', default: false })
  checked_by_admin: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  checked_at: Date | null;

  @Column({ type: 'bigint', nullable: true })
  checked_by_user_id: number | null;

  @ManyToOne(() => BotChannelUser, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bot_channel_user_id' })
  channelUser: BotChannelUser;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;
}
