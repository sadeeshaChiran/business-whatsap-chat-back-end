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
import { Company } from '../../company/entities/company.entity';
import { User } from '../../users/entities/user.entity';
import { BotConversation } from './bot-conversation.entity';
import { BotFlag } from './bot-flag.entity';

@Entity('bot_channel_user')
export class BotChannelUser {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  company_id: number;

  @Column({ type: 'int', nullable: true })
  app_user_id: number | null;

  @Column({ type: 'varchar', length: 30 })
  platform: string;

  @Column({ type: 'varchar', length: 255 })
  external_user_id: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  display_name: string;

  @Column({ type: 'varchar', length: 30, default: 'English' })
  language: string;

  @Column({ type: 'boolean', default: false })
  language_locked: boolean;

  @Column({ type: 'text', nullable: true })
  session_state: string | null;

  @Column({ type: 'boolean', default: true })
  bot_enabled: boolean;

  @Column({ type: 'boolean', default: false })
  manual_mode: boolean;

  @Column({ type: 'timestamp', nullable: true })
  last_seen_at: Date | null;

  @ManyToOne(() => Company, { nullable: false, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company: Company;

  @ManyToOne(() => User, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'app_user_id' })
  appUser: User | null;

  @OneToMany(() => BotConversation, (conversation) => conversation.channelUser)
  conversations: BotConversation[];

  @OneToMany(() => BotFlag, (flag) => flag.channelUser)
  flags: BotFlag[];

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp', name: 'updated_at' })
  updated_at: Date;
}
