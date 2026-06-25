import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
@Entity({ name: 'customers' })
export class SupabaseCustomer {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  company_id: number;

  @Column({ name: 'customer_phone', type: 'text' })
  customer_phone: string;

  @Column({ name: 'assigned_instance', type: 'text', nullable: true })
  assigned_instance: string | null;

  @Column({ type: 'bigint', nullable: true })
  last_agent_id: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_agent_accepted_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'first_seen_at' })
  first_seen_at: Date;

  @Column({ type: 'timestamptz', name: 'last_seen_at' })
  last_seen_at: Date;
}
