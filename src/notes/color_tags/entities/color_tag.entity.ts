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
import { Company } from '../../../company/entities/company.entity';
import { Note } from '../../entities/note.entity';

@Entity()
export class NoteColorTags {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  color_code: string;

  @Column({ type: 'varchar', length: 255 })
  meaning: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string | null;

  @ManyToOne(() => Company, (company) => company.colorTags, {
    nullable: true,
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'company_id' })
  company: Company | null;

  @OneToMany(() => Note, (note) => note.color_tag)
  notes: Note[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
