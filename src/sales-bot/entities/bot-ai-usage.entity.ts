import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** One row per bot reply: tokens, cost and speed (used by the Bot reports page). */
@Entity('bot_ai_usage')
export class BotAiUsage {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint' })
  company_id: number;

  @Column({ type: 'int', nullable: true })
  conversation_id: number | null;

  @Column({ type: 'varchar', length: 100, default: '' })
  model: string;

  @Column({ type: 'int', default: 0 })
  input_tokens: number;

  @Column({ type: 'int', default: 0 })
  cached_tokens: number;

  @Column({ type: 'int', default: 0 })
  output_tokens: number;

  @Column({ type: 'int', default: 1 })
  calls: number;

  @Column({ type: 'decimal', precision: 12, scale: 6, default: 0 })
  cost_usd: number;

  @Column({ type: 'int', default: 0 })
  latency_ms: number;

  /** Test chat usage (not a real customer) */
  @Column({ type: 'boolean', default: false })
  is_test: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;
}
