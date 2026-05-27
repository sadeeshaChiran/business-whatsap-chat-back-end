import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Company } from '../../company/entities/company.entity';

@Entity('bot_training_data')
export class BotTrainingData {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', nullable: true })
  company_id: number | null;

  @Column({ type: 'varchar', length: 100, default: '' })
  category: string;

  @Column({ type: 'text' })
  question: string;

  @Column({ type: 'text' })
  answer: string;

  @Column({ type: 'varchar', length: 30, default: 'English' })
  language: string;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @Column({ type: 'bytea', nullable: true, select: false })
  vector_embedding: Buffer | null;

  @ManyToOne(() => Company, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  @JoinColumn({ name: 'company_id' })
  company: Company | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
