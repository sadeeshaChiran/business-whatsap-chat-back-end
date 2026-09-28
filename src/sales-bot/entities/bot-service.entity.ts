import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** A service customers can book (haircut, treatment, class, room…). */
@Entity('bot_service')
export class BotService {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint' })
  company_id: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  price: number;

  @Column({ type: 'varchar', length: 50, default: '' })
  price_note: string;

  @Column({ type: 'int', nullable: true })
  duration_min: number | null;

  @Column({ type: 'boolean', default: true })
  is_active: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
