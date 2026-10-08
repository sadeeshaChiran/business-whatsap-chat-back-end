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

  @Column({ type: 'varchar', length: 30, default: 'new' })
  lead_stage: 'new' | 'contacted' | 'qualified' | 'proposal' | 'won' | 'lost';

  @Column({ type: 'bigint', nullable: true })
  assigned_agent_id: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  assigned_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  timeout_at: Date | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  assignment_mode: 'sticky' | 'round_robin' | 'manual' | 'unassigned' | null;

  @Column({ type: 'timestamp', nullable: true })
  last_message_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  agent_last_read_at: Date | null;

  /** Why the chat waits in the unassigned queue: bot_handoff | order_check | bot_error (sales bot) */
  @Column({ type: 'varchar', length: 30, nullable: true })
  queue_reason: string | null;

  @Column({ type: 'text', nullable: true })
  queue_note: string | null;

  /** What the sales bot learned about this lead: need, budget, location, contact time, order value… */
  @Column({ type: 'jsonb', nullable: true })
  lead_details: Record<string, unknown> | null;

  /**
   * Follow-up of an interested customer who went quiet:
   * waiting (a follow-up is planned) | sent (all sent, no answer) | converted (ordered) | stopped (no / a person took over) | off
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  followup_status: string | null;

  /** the bot's last view: none | browsing | interested | ready */
  @Column({ type: 'varchar', length: 12, nullable: true })
  followup_interest: string | null;

  /** what the customer wants and what is missing (short, from the bot) */
  @Column({ type: 'text', nullable: true })
  followup_note: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  followup_due_at: Date | null;

  @Column({ type: 'int', default: 0 })
  followup_count: number;

  @Column({ type: 'timestamptz', nullable: true })
  followup_last_at: Date | null;

  /** all follow-ups ever sent in this chat (for the conversion report) */
  @Column({ type: 'int', default: 0 })
  followup_total: number;

  /** the customer's last message before they went quiet (follow-up times count from here) */
  @Column({ type: 'timestamptz', nullable: true })
  followup_quiet_since: Date | null;

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
