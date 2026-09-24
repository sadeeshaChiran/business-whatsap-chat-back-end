import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('automation_flow')
export class AutomationFlow {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'bigint' }) company_id: number;
  @Column({ type: 'varchar', length: 255 }) name: string;
  @Column({ type: 'text', default: '' }) description: string;
  @Column({ type: 'varchar', length: 50, default: 'new_message' }) trigger_type: string;
  @Column({ type: 'varchar', length: 20, default: 'draft' }) status: 'draft' | 'active' | 'paused';
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` }) definition: { nodes: unknown[]; edges: unknown[] };
  @CreateDateColumn({ type: 'timestamptz' }) created_at: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at: Date;
}
