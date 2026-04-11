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
export class ColorTag {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 255 })
  color_code: string;

  @Column({ type: 'varchar', length: 255 })
  meaning: string;

  @ManyToOne(() => Company, (company) => company.colorTags, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({ name: 'company_id' })
  company: Company;

  @OneToMany(() => Note, (note) => note.color_tag)
  notes: Note[];

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp', name: 'updated_at' })
  updated_at: Date;
}
